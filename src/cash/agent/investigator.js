import { buildRepairPreview } from '../repair-plans.js';

export const AGENT_POLICY_VERSION = 'agent-2026-08-14.1';

function operatorAssignment(context, disposition, operator) {
  return {
    queue: operator.queue,
    assigneeId: null,
    assigneeName: null,
    requiredPermission: disposition === 'ready_for_approval' ? 'payments:create' : 'payments:view',
    commercialOwnerId: context?.ownerId ?? null,
    commercialOwnerName: context?.ownerName ?? null
  };
}

export function investigateReconciliation({ transfers, receipts, incidents, invoices, contexts, externalPayments,
  sourceCoverage, operator = {} }) {
  const owner = {
    queue: String(operator.queue ?? 'cash_application'),
    label: String(operator.label ?? 'Cash application')
  };
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const contextByCustomer = new Map();
  for (const context of contexts) {
    if (context.lagoCustomerId) contextByCustomer.set(context.lagoCustomerId, context);
    contextByCustomer.set(`salesforce:${context.crmAccountId}`, context);
  }
  const cases = [];
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));

  for (const incident of incidents) cases.push(investigateIncident(incident, invoiceById, contextByCustomer, sourceCoverage, owner));
  for (const transfer of transfers) {
    if (!['unreviewed', 'held', 'exception'].includes(transfer.reviewStatus)) continue;
    cases.push(investigateTransfer(transfer, receiptById.get(transfer.id), invoiceById, contextByCustomer, externalPayments, sourceCoverage, owner));
  }
  for (const receipt of receipts) {
    if (receipt.status === 'reversed' || receipt.unappliedAmountCents <= 0 || receipt.allocatedAmountCents <= 0) continue;
    if (transfers.some((transfer) => transfer.id === receipt.id && ['unreviewed', 'held', 'exception'].includes(transfer.reviewStatus))) continue;
    cases.push(investigateUnappliedReceipt(receipt, sourceCoverage, owner));
  }
  return cases.sort((a, b) => rank(a.priority) - rank(b.priority) || b.confidence - a.confidence);
}

// Cases are read by finance operators, not engineers. Every title states what happened and
// every rationale states the problem, then what the reader should do about it. Amounts are
// formatted, invoices are named, and internal vocabulary stays in the trace and evidence.
function money(cents, currency) {
  if (cents == null || !currency) return 'an unknown amount';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function payer(transfer) {
  return transfer.senderName ?? 'an unidentified payer';
}

function invoiceList(invoices) {
  const numbers = invoices.map((invoice) => invoice.number).filter(Boolean);
  if (!numbers.length) return '';
  if (numbers.length === 1) return numbers[0];
  return `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

// The receipt's own reference, quoted, or a phrase saying there wasn't one.
function quotedReference(transfer) {
  const reference = (transfer.reference ?? '').trim();
  return reference ? `"${reference}"` : 'no payment reference';
}

function investigateTransfer(transfer, receipt, invoiceById, contextByCustomer, externalPayments, sourceCoverage, operator) {
  const proposal = transfer.proposals[0];
  const proposedInvoices = (proposal?.allocations ?? []).map((allocation) => invoiceById.get(allocation.invoiceId)).filter(Boolean);
  const primaryInvoice = proposedInvoices[0];
  const context = primaryInvoice ? contextForInvoice(primaryInvoice, contextByCustomer) : null;
  const erpEvidence = findErpEvidence(externalPayments, proposedInvoices);
  const conflicts = proposal?.signals?.filter((signal) => signal.points < 0).map((signal) => signal.code) ?? [];
  const missingSources = Object.entries(sourceCoverage).filter(([, value]) => !['succeeded', 'available'].includes(value)).map(([name]) => name);
  // A tie is only explicable if the reader can see which invoices tied, so collect the
  // runners-up that scored level with the leader.
  const tied = transfer.proposals
    .filter((item) => item.score === proposal?.score)
    .flatMap((item) => item.allocations.map((allocation) => invoiceById.get(allocation.invoiceId)))
    .filter(Boolean);
  const uniqueTied = [...new Map(tied.map((invoice) => [invoice.id, invoice])).values()];
  let kind;
  let priority;
  let disposition;
  let confidence;
  let action;

  if (transfer.reviewStatus === 'exception' || transfer.status === 'reversed') {
    kind = 'receipt_reversal'; priority = 'critical'; disposition = 'blocked'; confidence = 100;
    action = { type: 'investigate_reversal', payload: { transferId: transfer.id } };
  } else if (!proposal) {
    kind = 'unmatched_receipt'; priority = 'high'; disposition = 'needs_remittance'; confidence = 0;
    action = { type: 'request_remittance', payload: remittanceDraft(transfer, context) };
  } else if (proposal.allocations.length > 1) {
    kind = 'split_allocation'; priority = 'high'; disposition = 'needs_review'; confidence = clamp(proposal.score);
    action = approvalAction(transfer, proposal, true);
  } else if (proposal.adjustments?.length) {
    kind = 'settlement_adjustment'; priority = 'high'; disposition = 'needs_review'; confidence = clamp(proposal.score);
    action = approvalAction(transfer, proposal, false);
  } else if (proposal.kind === 'remittance') {
    kind = 'remittance_allocation'; priority = 'high'; disposition = 'needs_review'; confidence = clamp(proposal.score);
    action = approvalAction(transfer, proposal, false);
  } else if (proposal.autoEligible) {
    kind = 'safe_match'; priority = 'medium'; disposition = 'ready_for_approval'; confidence = clamp(proposal.score);
    action = approvalAction(transfer, proposal, false);
  } else if (proposal.margin < 15) {
    kind = 'ambiguous_match'; priority = 'high'; disposition = 'needs_remittance'; confidence = clamp(Math.min(59, proposal.score));
    action = { type: 'request_remittance', payload: remittanceDraft(transfer, context, proposedInvoices) };
  } else {
    kind = 'suggested_match'; priority = 'medium'; disposition = 'needs_review'; confidence = clamp(proposal.score);
    action = approvalAction(transfer, proposal, false);
  }

  const evidence = [
    cite(transfer.provider, 'bank_transaction', transfer.providerTransactionId, 'settlement', {
      status: transfer.status, amountCents: transfer.amountCents, currency: transfer.currency,
      bookedAt: transfer.bookedAt, senderName: transfer.senderName, reference: transfer.reference
    }, 'receipt_authority'),
    ...proposedInvoices.map((invoice) => cite('lago', 'invoice', invoice.id, 'candidate_invoice', {
      number: invoice.number, customerId: invoice.customerId, remainingAmountCents: invoice.remainingAmountCents,
      currency: invoice.currency, paymentStatus: invoice.paymentStatus
    }, 'invoice_authority')),
    ...(context ? [cite('salesforce', 'account', context.crmAccountId, 'commercial_context', {
      accountName: context.accountName, parentName: context.parentName, aliases: context.aliases,
      ownerName: context.ownerName, expectedPaymentMethod: context.expectedPaymentMethod
    }, 'context_only')] : []),
    ...erpEvidence.map((payment) => cite(payment.provider, 'customer_payment', payment.providerPaymentId, 'erp_corroboration', {
      status: payment.status, amountCents: payment.amountCents, currency: payment.currency,
      reference: payment.reference, originSystem: payment.originSystem
    }, 'accounting_evidence')),
    ...(receipt?.evidenceLinks ?? []).map((link) => cite(link.sourceSystem, 'linked_evidence', link.sourceRecordId,
      link.relation, { ...link.metadata, direction: link.direction, amountCents: link.amountCents,
        currency: link.currency, occurredAt: link.occurredAt }, link.authority)),
    ...(receipt?.remittanceClaims ?? []).map((claim) => cite('remittance', 'claim', claim.id,
      'invoice_allocation_claim', {
        invoiceNumber: claim.invoiceNumber, amountCents: claim.amountCents, currency: claim.currency,
        locator: claim.citation.locator, excerpt: claim.citation.excerpt, textHash: claim.citation.textHash
      }, 'remittance_only'))
  ];

  const investigationTrace = [
    traceStep('observe_receipt', 'succeeded', `Observed settled ${transfer.currency} receipt from ${transfer.senderName ?? 'unknown payer'}.`),
    traceStep('rank_candidates', proposal ? 'succeeded' : 'inconclusive', proposal ? `${transfer.proposals.length} candidate(s); top score ${proposal.score}, margin ${proposal.margin}.` : 'No candidate crossed the minimum evidence threshold.'),
    traceStep('resolve_identity', context ? 'succeeded' : 'inconclusive', context ? `Linked to ${context.accountName}${context.parentName ? ` under ${context.parentName}` : ''}.` : 'No CRM identity was linked to the candidate.'),
    traceStep('corroborate_accounting', erpEvidence.length ? 'succeeded' : 'inconclusive', erpEvidence.length ? `${erpEvidence.length} external ERP payment record(s) corroborate the candidate.` : 'No independent ERP corroboration found.'),
    traceStep('apply_policy', 'succeeded', `Disposition: ${disposition}. Financial execution requires explicit approval.`)
  ];

  return {
    caseKey: `receipt:${transfer.id}`, kind, priority, disposition, confidence,
    ownerName: operator.label,
    assignment: operatorAssignment(context, action.type === 'approve_allocation' ? 'ready_for_approval' : disposition, operator),
    title: titleFor(kind, transfer, primaryInvoice,
      kind === 'split_allocation' ? proposedInvoices : uniqueTied),
    rationale: rationaleFor({ kind, proposal, transfer, invoice: primaryInvoice,
      competing: kind === 'split_allocation' ? proposedInvoices : uniqueTied,
      context, erpEvidence, conflicts, missingSources, operator }),
    action, amountCents: transfer.amountCents, currency: transfer.currency,
    evidence, trace: investigationTrace, sourceCoverage
  };
}

function investigateIncident(incident, invoiceById, contextByCustomer, sourceCoverage, operator) {
  const invoiceId = incident.evidence?.invoiceId ?? incident.evidence?.allocation?.invoiceId;
  const invoice = invoiceById.get(invoiceId);
  const context = invoice ? contextForInvoice(invoice, contextByCustomer) : null;
  return {
    caseKey: `incident:${incident.id}`, kind: incident.kind,
    priority: incident.severity === 'critical' ? 'critical' : 'high', disposition: 'blocked', confidence: 100,
    ownerName: operator.label, assignment: operatorAssignment(context, 'blocked', operator), title: incident.summary,
    rationale: incidentRationale(incident),
    action: { type: actionForIncident(incident.kind), payload: {
      incidentId: incident.id, invoiceId, repairPreview: buildRepairPreview(incident)
    } },
    amountCents: incident.evidence?.amountCents ?? null, currency: incident.evidence?.currency ?? null,
    evidence: [cite(incident.scope, 'incident', incident.id, 'divergence', incident.evidence, 'control_evidence')],
    trace: [traceStep('compare_systems', 'succeeded', incident.summary), traceStep('apply_policy', 'blocked', 'Corrective writes require review and a compensating audit event.')],
    sourceCoverage
  };
}

// Divergence cases are the ones operators find hardest to read, because the money is in one
// system and the invoice state is in another. Each says which two systems disagree and what
// must not be done about it.
function incidentRationale(incident) {
  const where = incident.scope.startsWith('erp:') ? incident.scope.replace('erp:', '') : 'Stripe';
  const invoice = incident.evidence?.invoiceNumber ?? incident.evidence?.invoiceId ?? 'the invoice';
  const byKind = {
    stripe_unallocated_cash_balance:
      `The customer's money is sitting in ${where} and has not been applied to any invoice. `
      + 'It is real cash, so do not raise a new invoice to collect it again — apply what is already there.',
    lago_invoice_missing_stripe_intent:
      `${invoice} is open in Lago, but ${where} has no payment attempt on record for it. `
      + `Whatever the customer paid cannot be traced to this invoice yet.`,
    lago_manual_payment_without_stripe_settlement:
      `${invoice} is marked paid in Lago because someone recorded a payment by hand, but ${where} shows no settled payment. `
      + 'Either the money arrived somewhere else, or it never arrived. Confirm before trusting the paid status.',
    stripe_settled_lago_unpaid:
      `${where} shows this as paid but Lago still shows ${invoice} as outstanding. `
      + 'The customer may be chased for money they have already sent, so resolve this before any dunning goes out.',
    stripe_allocation_reference_mismatch:
      `${where} applied the money to ${invoice}, but the payment reference points at a different invoice. `
      + 'One invoice is wrongly marked paid and another is wrongly still owed.',
    stripe_old_cash_auto_applied:
      `${where} settled ${invoice} using money that arrived before that invoice existed. `
      + 'Check which invoice the customer actually intended to pay before relying on the paid status.',
    duplicate_stripe_settlements:
      `${invoice} has more than one successful payment in ${where}, so the customer may have paid twice.`,
    stripe_stale_invoice_reference:
      `${where} refers to an invoice number that Lago has since changed, so the two systems name the same invoice differently.`
  };
  const lead = byKind[incident.kind]
    ?? `Lago and ${where} disagree about this payment. ${incident.summary}`;
  return `${lead} Nothing will be changed in either system until a person reviews the evidence and approves a fix.`;
}

function investigateUnappliedReceipt(receipt, sourceCoverage, operator) {
  return {
    caseKey: `unapplied:${receipt.id}`, kind: 'partially_unapplied_receipt', priority: 'high',
    disposition: 'needs_review', confidence: 100, ownerName: operator.label,
    assignment: operatorAssignment(null, 'needs_review', operator),
    title: `${money(receipt.unappliedAmountCents, receipt.currency)} of this payment is still unapplied`,
    rationale: `${money(receipt.grossAmountCents, receipt.currency)} was received and ${money(receipt.allocatedAmountCents, receipt.currency)} has been applied to invoices, leaving ${money(receipt.unappliedAmountCents, receipt.currency)}. `
      + 'That remainder stays visible as unapplied cash until someone decides where it belongs — it is never written off or hidden.',
    action: { type: 'allocate_remainder', payload: { receiptId: receipt.id, amountCents: receipt.unappliedAmountCents } },
    amountCents: receipt.unappliedAmountCents, currency: receipt.currency,
    evidence: [cite(receipt.sourceSystem, 'cash_receipt', receipt.sourceRecordId, 'unapplied_balance', receipt, 'receipt_authority')],
    trace: [traceStep('sum_allocations', 'succeeded', `Unapplied remainder is ${money(receipt.unappliedAmountCents, receipt.currency)}.`), traceStep('apply_policy', 'blocked', 'Agent cannot invent a customer credit or allocation.')],
    sourceCoverage
  };
}

function approvalAction(transfer, proposal, split) {
  return { type: 'approve_allocation', payload: {
    transferId: transfer.id, proposalId: proposal.id, allocations: proposal.allocations,
    adjustments: proposal.adjustments ?? [],
    execute: false, split, requiresApproval: true
  } };
}

function remittanceDraft(transfer, context, invoices = []) {
  const candidates = invoices.map((invoice) => invoice.number).join(', ');
  return {
    transferId: transfer.id, to: context?.billingContactEmail ?? null,
    commercialOwnerName: context?.ownerName ?? null, subject: `Remittance details for ${transfer.currency} payment`,
    body: `We received a ${transfer.currency} payment of ${(transfer.amountCents / 100).toFixed(2)} on ${String(transfer.bookedAt).slice(0, 10)}${transfer.reference ? ` with reference “${transfer.reference}”` : ''}. Could you confirm which invoice${candidates ? ` (${candidates})` : ''} this payment should be applied to?`,
    sendAutomatically: false
  };
}

function findErpEvidence(payments, invoices) {
  const ids = new Set(invoices.map((invoice) => invoice.id));
  const numbers = invoices.map((invoice) => invoice.number.toLowerCase());
  return payments.filter((payment) => payment.originSystem !== 'lago' && (
    payment.allocations.some((allocation) => ids.has(allocation.invoiceId)) ||
    numbers.some((number) => String(payment.reference ?? '').toLowerCase().includes(number))
  ));
}

function contextForInvoice(invoice, contexts) {
  return contexts.get(invoice.customerId) ??
    (invoice.customerExternalSalesforceId ? contexts.get(`salesforce:${invoice.customerExternalSalesforceId}`) : null);
}

function rationaleFor({ kind, proposal, transfer, invoice, competing = [], context, erpEvidence,
  conflicts, missingSources, operator }) {
  const amount = money(transfer?.amountCents, transfer?.currency);
  const parts = [];

  if (kind === 'receipt_reversal') {
    parts.push(`${amount} arrived from ${payer(transfer)} and the bank then reversed it, so the money is no longer in the account.`);
    parts.push('Nothing has been applied to any invoice, and any invoice this was meant to pay is still owed.');
    parts.push('Find out why the payment failed before treating the customer as paid.');
  } else if (kind === 'unmatched_receipt') {
    parts.push(`${amount} arrived from ${payer(transfer)} with ${quotedReference(transfer)}.`);
    parts.push('No open invoice has enough matching evidence to say which one it settles.');
    parts.push('Ask the payer what it was for, or pick the invoice yourself and record why.');
  } else if (kind === 'ambiguous_match') {
    const numbers = invoiceList(competing);
    parts.push(`${amount} arrived from ${payer(transfer)} with ${quotedReference(transfer)}, which does not name an invoice.`);
    parts.push(numbers
      ? `${competing.length} open invoices match it equally well — ${numbers} — so the evidence cannot break the tie.`
      : 'More than one open invoice matches it equally well, so the evidence cannot break the tie.');
    parts.push('Ask the payer which invoice this settles, or choose one and record why.');
  } else if (kind === 'split_allocation') {
    const numbers = invoiceList(competing);
    parts.push(`${amount} from ${payer(transfer)} is exactly the total still owed on ${numbers || 'several invoices'}.`);
    parts.push('One payment covering several invoices needs a person to confirm the breakdown before it is recorded.');
  } else if (kind === 'settlement_adjustment') {
    parts.push(`${amount} from ${payer(transfer)} does not exactly equal ${invoice?.number ?? 'the invoice'}.`);
    parts.push('The difference has been classified rather than absorbed, and needs approving as a named adjustment.');
  } else if (kind === 'remittance_allocation') {
    parts.push(`${payer(transfer)} supplied remittance advice saying which invoices this ${amount} covers.`);
    parts.push('Remittance advice is the payer\'s claim, not proof of settlement, so it still needs review.');
  } else if (kind === 'safe_match') {
    parts.push(`${amount} from ${payer(transfer)} matches ${invoice?.number ?? 'this invoice'} on both the reference and the exact amount owed.`);
    parts.push('This is the strongest evidence the policy recognises, so it is ready for a person to approve. It will not be recorded on its own.');
  } else {
    parts.push(`${amount} from ${payer(transfer)} looks like it settles ${invoice?.number ?? 'this invoice'}, but the evidence is not conclusive.`);
    if (proposal?.explanation) parts.push(proposal.explanation);
    parts.push('Check it before approving.');
  }

  if (context) parts.push(`${context.accountName} is linked in Salesforce for context only; it is not evidence that the money settled.`);
  if (erpEvidence.length) parts.push(`${erpEvidence.length} accounting record(s) outside Lago agree with this, which supports it but does not prove settlement.`);
  if (conflicts.length) parts.push(`Evidence against it: ${conflicts.map(readableConflict).join(', ')}.`);
  if (missingSources.length) {
    const shown = missingSources.slice(0, 3).join(', ');
    const rest = missingSources.length - 3;
    parts.push(`Not cross-checked against ${shown}${rest > 0 ? ` and ${rest} other unconnected source${rest > 1 ? 's' : ''}` : ''}.`);
  }
  return parts.join(' ');
}

// Signal codes are engineering vocabulary; operators need the meaning.
function readableConflict(code) {
  return {
    reference_mismatch: 'the payment reference does not name this invoice',
    sender_weak: 'the payer name does not resemble the customer',
    amount_over: 'the payment is larger than the amount still owed',
    before_invoice: 'the payment arrived before the invoice was issued',
    timing_old: 'the invoice is over a year old',
    currency_mismatch: 'the currencies differ'
  }[code] ?? code.replaceAll('_', ' ');
}

function titleFor(kind, transfer, invoice, competing = []) {
  const amount = money(transfer.amountCents, transfer.currency);
  if (kind === 'receipt_reversal') return `The bank took back ${amount} from ${payer(transfer)}`;
  if (kind === 'unmatched_receipt') return `${amount} arrived from ${payer(transfer)} — which invoice is it for?`;
  if (kind === 'ambiguous_match') {
    const numbers = invoiceList(competing);
    return numbers
      ? `${amount} from ${payer(transfer)} could settle ${numbers}`
      : `${amount} from ${payer(transfer)} matches more than one invoice`;
  }
  if (kind === 'split_allocation') return `${amount} from ${payer(transfer)} covers ${invoiceList(competing) || 'several invoices'}`;
  if (kind === 'settlement_adjustment') return `${amount} from ${payer(transfer)} does not equal ${invoice?.number ?? 'the invoice'} exactly`;
  if (kind === 'remittance_allocation') return `${payer(transfer)} sent remittance advice for ${invoice?.number ?? 'this payment'}`;
  if (kind === 'safe_match') return `Ready to approve: ${amount} against ${invoice?.number ?? 'a matching invoice'}`;
  return `Check whether ${amount} from ${payer(transfer)} settles ${invoice?.number ?? 'this invoice'}`;
}

function actionForIncident(kind) {
  if (kind.includes('reversed') || kind.includes('voided')) return 'review_compensating_action';
  if (kind.includes('missing_in_lago')) return 'review_external_payment_import';
  if (kind.includes('duplicate')) return 'investigate_duplicate';
  if (kind.includes('not_mapped')) return 'repair_identity_mapping';
  return 'review_divergence';
}

function cite(source, entityType, entityId, claim, fields, authority) {
  return { citation: `${source}:${entityType}:${entityId}`, source, entityType, entityId, claim, authority, fields };
}

function traceStep(step, status, conclusion) { return { step, status, conclusion }; }
const clamp = (value) => Math.max(0, Math.min(100, Math.round(value ?? 0)));
const rank = (value) => ({ critical: 0, high: 1, medium: 2, low: 3 }[value] ?? 4);

export function summarizeInvestigations(cases, steps = []) {
  const exposureByCurrency = {};
  for (const item of cases) if (item.amountCents && item.currency) exposureByCurrency[item.currency] = (exposureByCurrency[item.currency] ?? 0) + item.amountCents;
  return {
    totalCases: cases.length,
    critical: cases.filter((item) => item.priority === 'critical').length,
    readyForApproval: cases.filter((item) => item.disposition === 'ready_for_approval').length,
    needsRemittance: cases.filter((item) => item.disposition === 'needs_remittance').length,
    operatorQueueCases: cases.length,
    sourceFailures: steps.filter((step) => step.status === 'failed').length,
    financialWrites: 0,
    exposureByCurrency
  };
}
