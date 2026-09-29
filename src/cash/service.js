import { proposeMatches } from './matcher.js';
import { detectStripeIncidents } from './stripe-reconciler.js';
import { detectErpIncidents } from './erp-reconciler.js';
import { createHash } from 'node:crypto';
import { buildRepairPreview } from './repair-plans.js';
import { parseStatementCsv } from './connectors/statement-file.js';

export function lagoPaymentReference(transfer) {
  const provider = String(transfer.provider ?? 'cash').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const source = `${transfer.provider}:${transfer.accountId}:${transfer.providerTransactionId}`;
  return `lgr:${provider}:${createHash('sha256').update(source).digest('hex').slice(0, 23)}`;
}

export class ReconciliationService {
  constructor({ store, lago, mercury, qonto, brex, ramp, stripe, salesforce, erps = {}, stripeCustomerMap = {}, dryRun = true }) {
    Object.assign(this, { store, lago, mercury, qonto, brex, ramp, stripe, salesforce, erps, stripeCustomerMap, dryRun });
  }

  async syncInvoices({ match = true } = {}) {
    const invoices = this.lago.listInvoices ? await this.lago.listInvoices() : await this.lago.listOpenInvoices();
    for (const invoice of invoices) {
      this.store.upsertInvoice(invoice);
      for (const payment of invoice.payments ?? []) this.store.upsertLagoPayment(normalizeLagoPayment(payment, invoice.id));
    }
    this.store.audit('sync_completed', 'provider', 'lago', 'system', { count: invoices.length });
    if (match) this.rematchAll();
    return { count: invoices.length };
  }

  async syncStripe(customerId = null) {
    if (!this.stripe) throw new Error('Stripe connector is not configured');
    const customerIds = customerId ? [customerId] : Object.keys(this.stripeCustomerMap);
    if (!customerIds.length) throw new Error('STRIPE_CUSTOMER_MAP is empty');
    let eventCount = 0;
    let incidentCount = 0;
    for (const stripeCustomerId of customerIds) {
      const lagoCustomerId = this.stripeCustomerMap[stripeCustomerId];
      if (!lagoCustomerId) throw new Error(`No Lago customer mapping for Stripe customer ${stripeCustomerId}`);
      const [cashTransactions, paymentIntents] = await Promise.all([
        this.stripe.listCashBalanceTransactions(stripeCustomerId),
        this.stripe.listPaymentIntents(stripeCustomerId)
      ]);
      cashTransactions.forEach((event) => this.store.upsertStripeCashTransaction(event));
      paymentIntents.forEach((intent) => this.store.upsertStripePaymentIntent(intent));
      const incidents = detectStripeIncidents({
        customerId: stripeCustomerId, lagoCustomerId,
        invoices: this.store.listInvoices(), payments: this.store.listLagoPayments(),
        cashTransactions, paymentIntents
      });
      this.store.replaceIncidents(stripeCustomerId, incidents);
      eventCount += cashTransactions.length + paymentIntents.length;
      incidentCount += incidents.length;
    }
    this.store.audit('sync_completed', 'provider', 'stripe', 'system', { customers: customerIds.length, eventCount, incidentCount });
    return { customers: customerIds.length, eventCount, incidentCount };
  }

  async syncProvider(provider, options = {}) {
    const connector = { mercury: this.mercury, qonto: this.qonto, brex: this.brex, ramp: this.ramp }[provider];
    if (!connector) throw new Error(`Unsupported provider: ${provider}`);
    const transfers = await connector.listIncoming(options);
    for (const transfer of transfers) {
      this.ingestTransfer(transfer, { match: options.match !== false });
    }
    this.store.audit('sync_completed', 'provider', provider, 'system', { count: transfers.length });
    return { count: transfers.length };
  }

  importStatementFile({ format = 'csv', content, sourceSystem = 'statement_csv', accountId, mapping, amountUnit }, actor) {
    if (format !== 'csv') throw Object.assign(new Error('Only CSV statement import is implemented; CAMT.053, MT940, and BAI2 remain explicit next formats'), { status: 400 });
    const transfers = parseStatementCsv(content, { sourceSystem, accountId, mapping, amountUnit });
    const normalizedSourceSystem = transfers[0]?.provider ?? String(sourceSystem).trim().toLowerCase();
    let imported = 0;
    let ignored = 0;
    for (const transfer of transfers) {
      if (this.ingestTransfer(transfer)) imported += 1;
      else ignored += 1;
    }
    this.store.audit('statement_file_imported', 'provider', normalizedSourceSystem, actor, {
      format, accountId, observed: transfers.length, imported, ignored
    });
    return { format, sourceSystem: normalizedSourceSystem, accountId, observed: transfers.length, imported, ignored };
  }

  async syncErp(provider) {
    const connector = this.erps[provider];
    if (!connector) throw new Error(`Unsupported ERP: ${provider}`);
    const payments = await connector.listCustomerPayments();
    payments.forEach((payment) => this.store.upsertExternalPayment(payment));
    const incidents = detectErpIncidents({
      provider,
      payments,
      invoices: this.store.listInvoices(),
      lagoPayments: this.store.listLagoPayments()
    });
    this.store.replaceIncidents(`erp:${provider}`, incidents);
    this.store.audit('sync_completed', 'erp', provider, 'system', {
      count: payments.length,
      echoSuppressed: payments.filter((payment) => payment.originSystem === 'lago').length,
      incidents: incidents.length
    });
    return { count: payments.length, incidents: incidents.length };
  }

  async syncSalesforce() {
    if (!this.salesforce) throw new Error('Salesforce connector is not configured');
    const contexts = await this.salesforce.listAccountContexts();
    contexts.forEach((context) => this.store.upsertCustomerContext(context));
    const linked = contexts.filter((context) => context.lagoCustomerId).length;
    this.rematchAll();
    this.store.audit('sync_completed', 'crm', 'salesforce', 'system', { count: contexts.length, linked });
    return { count: contexts.length, linked };
  }

  ingestTransfer(transfer, { match = true } = {}) {
    if (transfer.direction !== 'credit') return null;
    if (!['posted', 'reversed'].includes(transfer.status)) return null;
    const id = this.store.upsertTransfer(transfer);
    if (transfer.status === 'reversed') {
      this.store.replaceProposals(id, []);
      this.store.setTransferReviewStatus(id, 'exception');
      this.store.markReceiptReversed(id);
      this.store.audit('transfer_reversed', 'transfer', id, 'system', { provider: transfer.provider });
      return id;
    }
    if (match) this.matchTransfer(id);
    return id;
  }

  attachReceiptEvidence(receiptId, evidence, actor) {
    const allowedAuthorities = new Set(['remittance_only', 'accounting_evidence', 'context_only']);
    if (!allowedAuthorities.has(evidence.authority)) {
      throw Object.assign(new Error('Linked evidence cannot become receipt authority'), { status: 400 });
    }
    const link = this.store.attachReceiptEvidence({ ...evidence, receiptId, addedBy: actor });
    this.store.audit('receipt_evidence_linked', 'cash_receipt', receiptId, actor, link);
    return link;
  }

  ingestRemittanceDocument(receiptId, document, actor) {
    const content = String(document.content ?? '');
    if (!content.trim()) throw Object.assign(new Error('Extracted remittance text is required'), { status: 400 });
    const contentHash = createHash('sha256').update(content).digest('hex');
    if (document.contentHash && document.contentHash !== contentHash) {
      throw Object.assign(new Error('Remittance content hash does not match the supplied text'), { status: 400 });
    }
    const claims = (document.claims ?? []).map((claim) => {
      const excerpt = String(claim.citation?.excerpt ?? '');
      if (!excerpt || !content.includes(excerpt)) {
        throw Object.assign(new Error('Every remittance claim excerpt must occur in the supplied text'), { status: 400 });
      }
      const textHash = createHash('sha256').update(excerpt).digest('hex');
      if (claim.citation?.textHash && claim.citation.textHash !== textHash) {
        throw Object.assign(new Error('Remittance citation hash does not match its excerpt'), { status: 400 });
      }
      return { ...claim, citation: { ...claim.citation, excerpt, textHash } };
    });
    const saved = this.store.upsertRemittanceDocument({
      receiptId, sourceSystem: document.sourceSystem, sourceRecordId: document.sourceRecordId,
      mimeType: document.mimeType, contentHash, extractor: document.extractor,
      extractorVersion: document.extractorVersion, metadata: document.metadata,
      claims, addedBy: actor
    });
    this.attachReceiptEvidence(receiptId, {
      sourceSystem: document.sourceSystem, sourceRecordId: document.sourceRecordId,
      relation: 'remittance_document', direction: 'unknown', authority: 'remittance_only',
      metadata: { documentId: saved.id, mimeType: saved.mimeType, claimCount: saved.claims.length, contentHash }
    }, actor);
    const proposals = this.matchTransfer(receiptId);
    return { document: saved, proposals };
  }

  configureCashApplicationPolicy(policy, actor) {
    const saved = this.store.upsertCashApplicationPolicy(policy, actor);
    this.rematchAll();
    return saved;
  }

  previewRepair(incidentId) {
    const incident = this.store.getIncident(incidentId);
    if (!incident) throw Object.assign(new Error('Incident not found'), { status: 404 });
    return buildRepairPreview(incident);
  }

  matchTransfer(transferId) {
    const transfer = this.store.getTransfer(transferId);
    if (!transfer) throw new Error(`Transfer not found: ${transferId}`);
    const candidates = proposeMatches(
      transfer, this.store.getOpenInvoices(), this.store.listIdentities(), this.store.listCustomerContexts(),
      { remittanceClaims: this.store.listRemittanceClaims(transferId), customerPolicies: this.store.listCashApplicationPolicies() }
    );
    const proposals = this.store.replaceProposals(transferId, candidates);
    this.store.audit('transfer_matched', 'transfer', transferId, 'matcher', {
      proposals: proposals.length,
      topScore: proposals[0]?.score ?? 0,
      autoEligible: proposals[0]?.autoEligible ?? false
    });
    return proposals;
  }

  rematchAll() {
    const transfers = this.store.listTransfers().filter((item) => ['unreviewed', 'held'].includes(item.reviewStatus));
    for (const transfer of transfers) this.matchTransfer(transfer.id);
    return transfers.length;
  }

  async approve({ transferId, proposalId = null, allocations: customAllocations = null,
    adjustments: customAdjustments = null, actor, note, rememberIdentity = false, execute = false }) {
    const transfer = this.store.getTransfer(transferId);
    const proposal = proposalId ? this.store.getProposal(proposalId) : null;
    if (!transfer || (proposalId && (!proposal || proposal.transferId !== transferId))) throw new Error('Invalid transfer or proposal');
    if (proposal && !this.store.excludeRejectedProposals(transferId, [proposal]).length) {
      throw Object.assign(new Error('This invoice match was rejected. Refresh the payment to review other matches.'), { status: 409 });
    }
    const allocations = proposal?.allocations ?? customAllocations ?? [];
    const adjustments = proposal?.adjustments ?? customAdjustments ?? [];
    const allocatedAmountCents = this.validateAllocations(transfer, allocations, adjustments);
    if (execute && !this.dryRun && (allocations.length > 1 || adjustments.length)) {
      throw Object.assign(new Error('Live split or adjustment execution requires one atomic Lago allocation command for cash application'), { status: 409 });
    }
    const decisionId = this.store.decide({
      transferId, proposalId, action: 'approve', allocations, adjustments, actor, note
    });

    if (rememberIdentity && transfer.senderAccountFingerprint && allocations.length) {
      const invoiceId = allocations[0].invoiceId;
      const invoice = this.store.getOpenInvoices().find((item) => item.id === invoiceId);
      if (invoice && allocations.every((allocation) => {
        const candidate = this.store.getOpenInvoices().find((item) => item.id === allocation.invoiceId);
        return candidate?.customerId === invoice.customerId;
      })) {
        this.store.confirmIdentity({
          fingerprint: transfer.senderAccountFingerprint,
          customerId: invoice.customerId,
          label: transfer.senderName,
          actor,
          transferId
        });
      }
    }

    if (execute) return this.executeDecision(decisionId, actor);
    return {
      decisionId,
      executionStatus: 'not_requested',
      allocatedAmountCents,
      unappliedAmountCents: this.store.getReceipt(transferId).unappliedAmountCents
    };
  }

  validateAllocations(transfer, allocations, adjustments = []) {
    if (!Array.isArray(allocations) || !allocations.length) throw new Error('At least one invoice allocation is required');
    if (transfer.status !== 'posted') throw Object.assign(new Error('Only settled receipts can be allocated'), { status: 409 });
    if (!Array.isArray(adjustments)) throw new Error('Adjustments must be an array');
    if (new Set(allocations.map((item) => item.invoiceId)).size !== allocations.length) throw new Error('An invoice cannot be allocated twice');
    const invoices = this.store.getOpenInvoices();
    const receipt = this.store.getReceipt(transfer.id);
    if (!receipt || receipt.status === 'reversed') throw Object.assign(new Error('A reversed or missing receipt cannot be allocated'), { status: 409 });
    const availableReceiptAmount = receipt.grossAmountCents - this.store.getReceiptCommittedAmount(transfer.id);
    let total = 0;
    const customerIds = new Set();
    const plannedByInvoice = new Map();
    for (const allocation of allocations) {
      const invoice = invoices.find((item) => item.id === allocation.invoiceId);
      const amount = Number(allocation.amountCents);
      if (!invoice) throw new Error(`Invoice is not open: ${allocation.invoiceId}`);
      if (invoice.currency !== transfer.currency) throw new Error('Allocation currency does not match transfer');
      const exposure = this.store.getInvoiceAllocationExposure(invoice.id);
      if (exposure.reversalRequired) throw Object.assign(new Error(`Invoice has an unresolved receipt reversal: ${invoice.id}`), { status: 409 });
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid allocation amount');
      plannedByInvoice.set(invoice.id, (plannedByInvoice.get(invoice.id) ?? 0) + amount);
      customerIds.add(invoice.customerId);
      total += amount;
    }
    const adjustmentByInvoice = new Map();
    for (const adjustment of adjustments) {
      const invoice = invoices.find((item) => item.id === adjustment.invoiceId);
      if (!invoice || !allocations.some((item) => item.invoiceId === adjustment.invoiceId)) {
        throw new Error('Every adjustment must accompany cash applied to the same open invoice');
      }
      if (adjustmentByInvoice.has(adjustment.invoiceId)) throw new Error('An invoice can have at most one settlement adjustment per decision');
      if (adjustment.currency !== transfer.currency || !Number.isInteger(adjustment.amountCents) || adjustment.amountCents <= 0) {
        throw new Error('Invalid settlement adjustment');
      }
      adjustmentByInvoice.set(adjustment.invoiceId, adjustment);
      plannedByInvoice.set(invoice.id, (plannedByInvoice.get(invoice.id) ?? 0) + adjustment.amountCents);
      customerIds.add(invoice.customerId);
    }
    for (const [invoiceId, planned] of plannedByInvoice) {
      const invoice = invoices.find((item) => item.id === invoiceId);
      const exposure = this.store.getInvoiceAllocationExposure(invoiceId);
      const availableInvoiceAmount = invoice.remainingAmountCents - exposure.reservedAmountCents;
      if (planned > availableInvoiceAmount) throw new Error('Invalid allocation amount');
      const adjustment = adjustmentByInvoice.get(invoiceId);
      if (adjustment) {
        if (planned !== availableInvoiceAmount) throw new Error('A settlement adjustment must close the available invoice balance exactly');
        assertAdjustmentAllowed(adjustment, availableInvoiceAmount, this.store.getCashApplicationPolicy(invoice.customerId));
      }
    }
    if (customerIds.size !== 1) throw Object.assign(new Error('One receipt cannot be allocated across different Lago customers in the MVP'), { status: 409 });
    if (total > availableReceiptAmount) throw new Error('Allocations cannot exceed the receipt\'s unapplied amount');
    return total;
  }

  reject({ transferId, proposalId, actor, note }) {
    const proposal = this.store.getProposal(proposalId);
    if (!proposal || proposal.transferId !== transferId) throw new Error('Invalid transfer or proposal');
    const decisionId = this.store.decide({ transferId, proposalId, action: 'reject', allocations: [], actor, note });
    return { decisionId };
  }

  hold({ transferId, actor, note }) {
    const decisionId = this.store.decide({ transferId, action: 'hold', allocations: [], actor, note });
    return { decisionId };
  }

  voidApproval({ decisionId, actor, reason }) {
    return this.store.voidDecision(decisionId, actor, reason);
  }

  async executeDecision(decisionId, actor) {
    const decision = this.store.getDecision(decisionId);
    if (!decision || decision.action !== 'approve') throw new Error('Only approved decisions can be executed');
    if (decision.execution_status === 'succeeded' || decision.execution_status === 'dry_run') return decision.executionResult;
    if (['voided', 'reversal_required'].includes(decision.execution_status)) {
      throw Object.assign(new Error('A voided approval or one awaiting reversal cannot be executed'), { status: 409 });
    }
    const transfer = this.store.getTransfer(decision.transfer_id);
    const receipt = this.store.getReceipt(decision.transfer_id);
    if (!transfer || !receipt || receipt.status === 'reversed' || transfer.status !== 'posted') {
      throw Object.assign(new Error('The receipt is not settled and eligible for execution'), { status: 409 });
    }
    if (!this.dryRun && (decision.allocations.length > 1 || decision.adjustments.length)) {
      throw Object.assign(new Error('Live split or adjustment execution requires one atomic Lago allocation command for cash application'), { status: 409 });
    }
    if (!this.store.claimDecisionExecution(decisionId, actor)) {
      throw Object.assign(new Error('Decision execution is already in progress under an active lease'), { status: 409 });
    }
    // Lago's existing manual-payment UI/API caps references at 40 characters.
    // The full source identity remains in our receipt/audit records.
    const reference = lagoPaymentReference(transfer);

    const payments = [];
    try {
      if (this.dryRun) {
        const result = {
          dryRun: true,
          payments: decision.allocations.map((allocation) => ({ ...allocation, reference })),
          adjustments: decision.adjustments,
          unappliedAmountCents: this.store.getReceipt(decision.transfer_id).unappliedAmountCents
        };
        this.store.updateDecisionExecution(decisionId, 'dry_run', result);
        this.store.audit('execution_dry_run', 'decision', String(decisionId), actor, result);
        return result;
      }
      // Recheck the reviewed invoice immediately before the only external write.
      // Multi-invoice execution is blocked until Lago exposes one atomic command.
      const executionPlan = [];
      for (const allocation of decision.allocations) {
        const existing = await this.lago.findPaymentByReference?.(allocation.invoiceId, reference);
        if (existing) {
          executionPlan.push({ allocation, existing });
          continue;
        }
        const currentInvoice = await this.lago.getInvoice?.(allocation.invoiceId);
        if (currentInvoice && (currentInvoice.paymentStatus === 'succeeded' || currentInvoice.remainingAmountCents < allocation.amountCents)) {
          throw new Error(`Invoice balance changed before execution: ${allocation.invoiceId}`);
        }
        executionPlan.push({ allocation, existing: null });
      }
      for (const { allocation, existing } of executionPlan) {
        if (existing) {
          payments.push({ payment: existing, idempotentReplay: true });
          continue;
        }
        payments.push(await this.lago.createPayment({
          invoiceId: allocation.invoiceId,
          amountCents: allocation.amountCents,
          reference,
          paidAt: transfer.bookedAt
        }));
      }
      const result = { dryRun: false, payments };
      this.store.updateDecisionExecution(decisionId, 'succeeded', result);
      this.store.audit('execution_succeeded', 'decision', String(decisionId), actor, result);
      return result;
    } catch (error) {
      const result = { message: error.message, status: error.status, completedPayments: payments };
      this.store.updateDecisionExecution(decisionId, 'failed', result);
      this.store.audit('execution_failed', 'decision', String(decisionId), actor, result);
      throw error;
    }
  }

  async processWebhook(provider, rawBody, signatureHeader) {
    const connector = provider === 'mercury' ? this.mercury : provider === 'qonto' ? this.qonto : null;
    if (!connector) throw new Error('Unknown provider');
    if (!connector.verifyWebhook(rawBody, signatureHeader)) {
      const error = new Error('Invalid or expired webhook signature');
      error.status = 401;
      throw error;
    }
    const payload = JSON.parse(rawBody);
    const eventId = payload.id;
    if (!eventId) throw new Error('Webhook event ID is required');
    if (this.store.hasWebhookEvent(provider, eventId)) return { duplicate: true };
    const isTransactionEvent = provider === 'mercury'
      ? payload.resourceType === 'transaction'
      : payload.type === 'v1/transactions';
    if (!isTransactionEvent) {
      this.store.recordWebhookEvent(provider, eventId, payload);
      return { accepted: true, ignored: true };
    }
    const transactionId = provider === 'mercury' ? payload.resourceId : payload.data?.id;
    if (!transactionId) {
      this.store.recordWebhookEvent(provider, eventId, payload);
      return { accepted: true, ignored: true };
    }
    const transfer = await connector.getTransaction(transactionId);
    if (transfer.direction !== 'credit' || !['posted', 'reversed'].includes(transfer.status)) {
      this.store.recordWebhookEvent(provider, eventId, payload);
      return { accepted: true, ignored: true };
    }
    const id = this.ingestTransfer(transfer);
    this.store.recordWebhookEvent(provider, eventId, payload);
    return { accepted: true, transferId: id };
  }
}

function assertAdjustmentAllowed(adjustment, availableInvoiceAmount, policy) {
  if (!policy?.enabled || policy.version !== adjustment.policyVersion) {
    throw new Error('Settlement adjustment requires the current enabled customer policy');
  }
  const gap = adjustment.amountCents;
  if (adjustment.type === 'bank_fee_writeoff' && gap <= policy.maxBankFeeCents) return;
  const expectedWithholding = Math.round(availableInvoiceAmount * policy.withholdingBps / 10_000);
  if (adjustment.type === 'withholding_tax' && expectedWithholding > 0 && Math.abs(expectedWithholding - gap) <= 1) return;
  const maxShortPay = Math.max(policy.maxShortPayCents,
    Math.round(availableInvoiceAmount * policy.maxShortPayBps / 10_000));
  if (adjustment.type === 'short_pay' && gap <= maxShortPay) return;
  throw new Error('Settlement adjustment exceeds the configured customer policy');
}

function normalizeLagoPayment(raw, invoiceId) {
  const status = String(raw.payment_status ?? raw.status ?? '').toLowerCase();
  return {
    id: raw.lago_id ?? raw.id,
    invoiceId,
    status: status === 'completed' ? 'succeeded' : status,
    amountCents: Number(raw.amount_cents ?? 0),
    providerPaymentId: raw.provider_payment_id ?? null,
    providerCode: raw.payment_provider_code ?? raw.payment_provider_type ?? null,
    reference: raw.reference ?? null,
    paidAt: raw.paid_at ?? raw.created_at ?? null,
    raw
  };
}
