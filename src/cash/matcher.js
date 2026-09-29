import { normalizeCompany, referenceEvidence, stringSimilarity, tokenSimilarity } from './text.js';

export const POLICY_VERSION = '2026-08-14.1';

function daysBetween(a, b) {
  const left = dateOnlyUtc(a);
  const right = dateOnlyUtc(b);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.floor((left - right) / 86_400_000) : Number.NaN;
}

function dateOnlyUtc(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
}

function signal(code, label, points, kind = points >= 0 ? 'support' : 'conflict', detail = '') {
  return { code, label, points, kind, detail };
}

export function scoreInvoice(transfer, invoice, confirmedIdentities = [], customerContexts = []) {
  const signals = [];
  const blockers = [];
  const remaining = Number(invoice.remainingAmountCents ?? invoice.totalAmountCents);
  const amount = Number(transfer.amountCents);

  if (transfer.currency !== invoice.currency) {
    blockers.push('currency_mismatch');
    signals.push(signal('currency_mismatch', 'Different currency', -100, 'blocker', `${transfer.currency} vs ${invoice.currency}`));
  } else {
    signals.push(signal('currency_match', 'Same currency', 8));
  }

  if (amount === remaining) signals.push(signal('amount_exact', 'Exact remaining balance', 34, 'support', String(amount)));
  else if (amount > 0 && amount < remaining) signals.push(signal('amount_partial', 'Valid partial payment', 14, 'support', `${amount} of ${remaining}`));
  else if (amount > remaining) signals.push(signal('amount_over', 'Transfer exceeds remaining balance', -20, 'conflict', `${amount} vs ${remaining}`));

  const referenceText = [transfer.reference, transfer.description, transfer.note].filter(Boolean).join(' ');
  const reference = referenceEvidence(referenceText, invoice.number);
  signals.push(signal(`reference_${reference.kind}`, `Reference ${reference.kind.replace('_', ' ')}`, reference.score,
    reference.score > 0 ? 'support' : reference.score < 0 ? 'conflict' : 'neutral',
    `similarity ${Math.round(reference.similarity * 100)}%`));

  const fingerprint = transfer.senderAccountFingerprint;
  const identity = confirmedIdentities.find((item) => item.fingerprint === fingerprint && item.customerId === invoice.customerId);
  if (identity) signals.push(signal('identity_confirmed', 'Previously confirmed sender account', 55, 'support', identity.label ?? fingerprint));

  const normalizedSender = normalizeCompany(transfer.senderName);
  const normalizedNames = [normalizeCompany(invoice.customerName), normalizeCompany(invoice.customerLegalName ?? '')];
  const senderSimilarity = Math.max(...normalizedNames.flatMap((name) => [
    tokenSimilarity(normalizedSender, name), stringSimilarity(normalizedSender, name)
  ]));
  if (senderSimilarity >= 0.9) signals.push(signal('sender_strong', 'Sender closely matches customer', 25, 'support', `${Math.round(senderSimilarity * 100)}%`));
  else if (senderSimilarity >= 0.62) signals.push(signal('sender_possible', 'Sender may match customer', 13, 'support', `${Math.round(senderSimilarity * 100)}%`));
  else if (transfer.senderName) signals.push(signal('sender_weak', 'Sender name does not match well', -5, 'conflict', `${Math.round(senderSimilarity * 100)}%`));

  const context = customerContexts.find((item) => item.lagoCustomerId === invoice.customerId ||
    (invoice.customerExternalSalesforceId && item.crmAccountId === invoice.customerExternalSalesforceId));
  const crmNames = context ? [context.accountName, context.parentName, ...(context.aliases ?? [])].filter(Boolean) : [];
  const crmSimilarity = crmNames.length ? Math.max(...crmNames.flatMap((name) => [
    tokenSimilarity(normalizedSender, normalizeCompany(name)), stringSimilarity(normalizedSender, normalizeCompany(name))
  ])) : 0;
  if (crmSimilarity >= 0.9) {
    signals.push(signal('crm_payer_identity', 'Sender matches CRM payer identity', 28, 'support', `${Math.round(crmSimilarity * 100)}% · contextual evidence only`));
  } else if (crmSimilarity >= 0.7) {
    signals.push(signal('crm_payer_possible', 'Sender may match a CRM payer alias', 12, 'support', `${Math.round(crmSimilarity * 100)}% · contextual evidence only`));
  }

  const age = daysBetween(transfer.bookedAt, invoice.issuedAt);
  if (Number.isFinite(age) && age >= 0 && age <= 90) signals.push(signal('timing_good', 'Paid within 90 days of issue', 6, 'support', `${age} days`));
  else if (Number.isFinite(age) && age < 0) signals.push(signal('before_invoice', 'Transfer predates invoice', -18, 'conflict', `${Math.abs(age)} days`));
  else if (Number.isFinite(age) && age > 365) signals.push(signal('timing_old', 'Invoice is over a year old', -5, 'conflict', `${age} days`));

  if (transfer.status !== 'posted') blockers.push('transfer_not_settled');
  if (transfer.direction && transfer.direction !== 'credit') blockers.push('transfer_not_incoming');
  if (remaining <= 0 || invoice.paymentStatus === 'succeeded') blockers.push('invoice_already_paid');
  if (amount <= 0) blockers.push('non_positive_transfer');

  const rawScore = signals.reduce((total, item) => total + item.points, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  return {
    invoice,
    score,
    // Unclamped total. Two candidates can both saturate the 0-100 display score, which
    // would erase the margin that gates auto-eligibility; ranking uses this instead.
    rawScore,
    signals,
    blockers,
    referenceKind: reference.kind,
    exactAmount: amount === remaining,
    confirmedIdentity: Boolean(identity)
  };
}

function buildSplitProposals(transfer, scored, { maxCandidateInvoices = 50, maxSplitInvoices = 50, maxSplitStates = 25_000 } = {}) {
  const target = Number(transfer.amountCents);
  const byCustomer = new Map();
  for (const item of scored.filter((candidate) => !candidate.blockers.length && candidate.score >= 8)
    .slice(0, maxCandidateInvoices)) {
    if (item.invoice.currency !== transfer.currency) continue;
    const key = item.invoice.customerId;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(item);
  }

  const proposals = [];
  for (const candidates of byCustomer.values()) {
    // Bounded subset-sum avoids the old three-invoice ceiling without an
    // exponential combinations walk. Remittance claims take the direct path
    // below and therefore do not depend on this search bound.
    let sums = new Map([[0, []]]);
    for (const candidate of candidates) {
      const amount = Number(candidate.invoice.remainingAmountCents);
      const additions = [];
      for (const [sum, group] of sums) {
        const next = sum + amount;
        if (next > target || group.length >= maxSplitInvoices || sums.has(next)) continue;
        additions.push([next, [...group, candidate]]);
      }
      for (const [sum, group] of additions) {
        sums.set(sum, group);
        if (sums.size >= maxSplitStates) break;
      }
      if (sums.has(target) || sums.size >= maxSplitStates) break;
    }
    const group = sums.get(target);
    if (!group || group.length < 2) continue;
    const score = Math.min(94, Math.round(group.reduce((sum, item) => sum + item.score, 0) / group.length) + 50);
    proposals.push({
      kind: 'split', score, confidence: 'strong', margin: 0,
      allocations: group.map((item) => ({ invoiceId: item.invoice.id, amountCents: item.invoice.remainingAmountCents })),
      adjustments: [], invoiceIds: group.map((item) => item.invoice.id),
      signals: [signal('split_exact_total', 'Transfer exactly covers these invoices', 18, 'support', `${group.length} invoices`)],
      blockers: [], autoEligible: false,
      explanation: `Exact total across ${group.length} invoices for ${group[0].invoice.customerName}; review is required.`
    });
  }
  return proposals;
}

export function proposeMatches(transfer, invoices, confirmedIdentities = [], customerContexts = [], options = {}) {
  const scored = invoices.map((invoice) => scoreInvoice(transfer, invoice, confirmedIdentities, customerContexts));
  scored.sort((a, b) => b.rawScore - a.rawScore);
  const viable = scored.filter((item) => !item.blockers.length && item.score >= 12);
  const runnerUp = viable[1]?.rawScore ?? 0;
  const singles = viable.slice(0, 8).map((item, index) => {
    const margin = item.rawScore - (index === 0 ? runnerUp : viable[0]?.rawScore ?? 0);
    const safeExactReference = ['exact', 'contained'].includes(item.referenceKind) && item.exactAmount;
    const safeKnownIdentity = item.confirmedIdentity && item.exactAmount && margin >= 18;
    const autoEligible = index === 0 && (safeExactReference || safeKnownIdentity) && margin >= 15 && item.score >= 80;
    const confidence = autoEligible ? 'automatic' : item.score >= 60 && margin >= 10 ? 'strong' : item.score >= 35 ? 'possible' : 'weak';
    return {
      kind: 'single',
      score: item.score,
      confidence,
      margin,
      allocations: [{ invoiceId: item.invoice.id, amountCents: Math.min(transfer.amountCents, item.invoice.remainingAmountCents) }],
      adjustments: [],
      invoiceIds: [item.invoice.id],
      signals: item.signals,
      blockers: item.blockers,
      autoEligible,
      explanation: explain(item.signals, confidence, margin)
    };
  });
  const remittance = buildRemittanceProposal(transfer, invoices, options.remittanceClaims ?? []);
  const tolerances = buildToleranceProposals(transfer, scored, options.customerPolicies ?? []);
  const splits = buildSplitProposals(transfer, scored, options.splitPolicy);
  return [...remittance, ...tolerances, ...singles, ...splits].sort((a, b) => b.score - a.score).slice(0, 10);
}

function buildRemittanceProposal(transfer, invoices, claims) {
  if (!Array.isArray(claims) || !claims.length) return [];
  const byNumber = new Map(invoices.map((invoice) => [normalizeInvoiceNumber(invoice.number), invoice]));
  const allocations = [];
  const matchedInvoices = [];
  const seen = new Set();
  for (const claim of claims) {
    const invoice = byNumber.get(normalizeInvoiceNumber(claim.invoiceNumber));
    if (!invoice || seen.has(invoice.id) || invoice.currency !== claim.currency || claim.currency !== transfer.currency) return [];
    if (!Number.isInteger(claim.amountCents) || claim.amountCents <= 0 || claim.amountCents > invoice.remainingAmountCents) return [];
    seen.add(invoice.id);
    allocations.push({ invoiceId: invoice.id, amountCents: claim.amountCents });
    matchedInvoices.push(invoice);
  }
  if (new Set(matchedInvoices.map((invoice) => invoice.customerId)).size !== 1) return [];
  if (allocations.reduce((sum, item) => sum + item.amountCents, 0) !== Number(transfer.amountCents)) return [];
  const citationsPresent = claims.every((claim) => claim.citation?.locator && claim.citation?.textHash);
  if (!citationsPresent) return [];
  return [{
    kind: 'remittance', score: 98, confidence: 'strong', margin: 0,
    allocations, adjustments: [], invoiceIds: matchedInvoices.map((invoice) => invoice.id),
    signals: [signal('remittance_verified', 'Cited remittance claims match Lago invoices and receipt total', 70, 'support', `${claims.length} cited claim(s)`)],
    blockers: [], autoEligible: false,
    explanation: `Cited remittance claims deterministically verify ${claims.length} invoice allocation(s); operator approval is still required.`
  }];
}

function buildToleranceProposals(transfer, scored, policies) {
  const policyByCustomer = new Map((policies ?? []).map((policy) => [policy.customerId, policy]));
  const proposals = [];
  for (const item of scored.filter((candidate) => !candidate.blockers.length)) {
    const remaining = Number(item.invoice.remainingAmountCents);
    const received = Number(transfer.amountCents);
    const gap = remaining - received;
    if (gap <= 0) continue;
    const policy = policyByCustomer.get(item.invoice.customerId);
    if (!policy) continue;
    const type = toleranceType(gap, remaining, policy);
    if (!type) continue;
    proposals.push({
      kind: 'tolerance', score: Math.min(92, item.score + 28), confidence: 'strong', margin: 0,
      allocations: [{ invoiceId: item.invoice.id, amountCents: received }],
      adjustments: [{ invoiceId: item.invoice.id, type, amountCents: gap, currency: transfer.currency,
        policyVersion: policy.version }],
      invoiceIds: [item.invoice.id],
      signals: [...item.signals, signal(`tolerance_${type}`, `Configured ${type.replaceAll('_', ' ')} tolerance`, 28, 'support', `${gap} minor units`)],
      blockers: [], autoEligible: false,
      explanation: `Receipt is ${gap} minor units short under the customer's ${type.replaceAll('_', ' ')} policy; explicit approval and a Lago adjustment command are required.`
    });
  }
  return proposals;
}

function toleranceType(gap, invoiceAmount, policy) {
  if (Number(policy.maxBankFeeCents ?? 0) >= gap) return 'bank_fee_writeoff';
  const withholding = Math.round(invoiceAmount * Number(policy.withholdingBps ?? 0) / 10_000);
  if (withholding > 0 && Math.abs(withholding - gap) <= 1) return 'withholding_tax';
  const maxShortPay = Math.max(Number(policy.maxShortPayCents ?? 0),
    Math.round(invoiceAmount * Number(policy.maxShortPayBps ?? 0) / 10_000));
  return maxShortPay >= gap ? 'short_pay' : null;
}

const normalizeInvoiceNumber = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function explain(signals, confidence, margin) {
  const strongest = signals.filter((item) => item.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map((item) => item.label.toLowerCase());
  const conflicts = signals.filter((item) => item.points < 0).map((item) => item.label.toLowerCase());
  const reason = strongest.length ? strongest.join(', ') : 'little positive evidence';
  const caveat = conflicts.length ? `; caution: ${conflicts.join(', ')}` : '';
  return `${confidence} match because of ${reason}${caveat}. Candidate margin: ${margin}.`;
}
