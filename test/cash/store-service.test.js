import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReconciliationStore } from '../../src/cash/db.js';
import { ReconciliationService, lagoPaymentReference } from '../../src/cash/service.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-cash-'));
  const store = new ReconciliationStore(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  const payments = [];
  const service = new ReconciliationService({
    store, dryRun: true,
    lago: { createPayment: async (payload) => { payments.push(payload); return payload; } },
    mercury: {}, qonto: {}
  });
  return { store, service, payments };
}

const invoice = { id: 'inv1', number: 'LAG-1', customerId: 'cus1', customerName: 'Acme', currency: 'USD', totalAmountCents: 10000, remainingAmountCents: 10000, status: 'finalized', paymentStatus: 'pending', issuedAt: '2026-08-01' };
const transfer = { provider: 'mercury', accountId: 'acc1', providerTransactionId: 'txn1', status: 'posted', direction: 'credit', amountCents: 10000, currency: 'USD', bookedAt: '2026-08-10', senderName: 'Acme', reference: 'LAG-1' };

test('rejected matches stay rejected after reimport, changed balances, and database reopen', async (t) => {
  const { store, service, payments } = setup(t);
  store.upsertInvoice(invoice);
  const id = service.ingestTransfer(transfer);
  const proposal = store.listProposals(id)[0];
  service.reject({ transferId: id, proposalId: proposal.id, actor: 'reviewer' });
  assert.deepEqual(service.matchTransfer(id), []);
  service.ingestTransfer({ ...transfer, description: 'refreshed bank data' });
  store.upsertInvoice({ ...invoice, remainingAmountCents: 8000 });
  service.rematchAll();
  assert.deepEqual(store.listProposals(id), []);
  assert.equal(store.getTransfer(id).reviewStatus, 'unreviewed');
  await assert.rejects(service.approve({ transferId: id, proposalId: proposal.id, actor: 'stale-tab', execute: true }), /match was rejected/);
  assert.equal(payments.length, 0);
  const filename = store.db.prepare('PRAGMA database_list').get().file;
  const reopened = new ReconciliationStore(filename);
  try {
    assert.deepEqual(reopened.replaceProposals(id, [proposal]), []);
    assert.deepEqual(reopened.listProposals(id), []);
  } finally { reopened.close(); }
  const anotherReceipt = service.ingestTransfer({ ...transfer, providerTransactionId: 'txn2' });
  assert(store.listProposals(anotherReceipt).length > 0);
});

test('rejection hides existing duplicate suggestions and keeps other invoice combinations', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const id = service.ingestTransfer(transfer);
  const original = store.listProposals(id)[0];
  const split = { ...original, allocations: [{ invoiceId: 'inv1', amountCents: 5000 }, { invoiceId: 'inv2', amountCents: 5000 }] };
  store.replaceProposals(id, [split, { ...split, allocations: [...split.allocations].reverse() }, { ...original, allocations: [{ invoiceId: 'inv3', amountCents: 10000 }] }]);
  const [rejected, stale, alternative] = store.listProposals(id);
  service.reject({ transferId: id, proposalId: rejected.id, actor: 'reviewer' });
  assert.deepEqual(store.listProposals(id).map(p => p.id), [alternative.id]);
  store.replaceProposals(id, [{ ...stale, score: 100, allocations: stale.allocations.map(a => ({ ...a, amountCents: 4000 })) }, alternative]);
  assert.deepEqual(store.listProposals(id).map(p => p.allocations[0].invoiceId), ['inv3']);
});

test('Lago payment references are deterministic and fit the current 40-character limit', () => {
  const long = { ...transfer, accountId: 'account-with-an-extremely-long-identifier', providerTransactionId: 'transaction-with-an-extremely-long-identifier' };
  assert.equal(lagoPaymentReference(long, 1), lagoPaymentReference(long, 1));
  assert.notEqual(lagoPaymentReference(long, 1), lagoPaymentReference(long, 2));
  assert(lagoPaymentReference(long, 999999999).length <= 40);
});

test('upsert is idempotent on provider, account, and transaction ID', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const first = service.ingestTransfer(transfer);
  const second = service.ingestTransfer({ ...transfer, description: 'updated' });
  assert.equal(first, second);
  assert.equal(store.listTransfers().length, 1);
  assert.equal(store.listReceipts().length, 1);
  assert.equal(store.listReceipts()[0].sourceSystem, 'mercury');
});

test('payer-side remittance is persisted as evidence without becoming receipt authority', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const receiptId = service.ingestTransfer({ ...transfer, provider: 'brex', accountId: 'destination' });
  const link = service.attachReceiptEvidence(receiptId, {
    sourceSystem: 'ramp', sourceRecordId: 'ramp-out-1', relation: 'payer_remittance',
    direction: 'debit', authority: 'remittance_only', amountCents: 10000, currency: 'USD',
    occurredAt: '2026-08-09T00:00:00Z', metadata: { memo: 'LAG-1' }
  }, 'finance-reviewer');
  assert.equal(link.authority, 'remittance_only');
  assert.equal(store.getReceipt(receiptId).evidenceLinks[0].sourceSystem, 'ramp');
  assert.throws(() => service.attachReceiptEvidence(receiptId, {
    sourceSystem: 'ramp', sourceRecordId: 'ramp-out-2', relation: 'payer_remittance',
    direction: 'debit', authority: 'receipt_authority'
  }, 'finance-reviewer'), /linked evidence cannot become receipt authority/i);
});

test('approval records an audit decision and dry-run execution without Lago writes', async (t) => {
  const { store, service, payments } = setup(t);
  store.upsertInvoice(invoice);
  const transferId = service.ingestTransfer(transfer);
  const proposal = store.listProposals(transferId)[0];
  const result = await service.approve({ transferId, proposalId: proposal.id, actor: 'tester', execute: true });
  assert.equal(result.dryRun, true);
  assert.equal(payments.length, 0);
  assert.equal(store.listTransfers()[0].reviewStatus, 'approved');
});

test('remembering a reviewed sender identity affects future reference-free matches', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const withFingerprint = { ...transfer, senderAccountFingerprint: 'bank-hash' };
  const transferId = service.ingestTransfer(withFingerprint);
  const proposal = store.listProposals(transferId)[0];
  await service.approve({ transferId, proposalId: proposal.id, actor: 'tester', rememberIdentity: true });
  assert.equal(store.listIdentities()[0].customerId, 'cus1');
});

test('a reversed incoming transfer becomes an exception with no match proposals', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const transferId = service.ingestTransfer({ ...transfer, status: 'reversed' });
  const item = store.listTransfers()[0];
  assert.equal(item.id, transferId);
  assert.equal(item.reviewStatus, 'exception');
  assert.equal(item.proposals.length, 0);
});

test('live execution checks Lago for the bank reference before creating a payment', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice(invoice);
  const calls = [];
  const liveService = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => ({ lago_id: 'existing', reference: lagoPaymentReference(transfer, 1) }),
      createPayment: async (payload) => { calls.push(payload); return payload; }
    }
  });
  const transferId = liveService.ingestTransfer(transfer);
  const proposal = store.listProposals(transferId)[0];
  const result = await liveService.approve({ transferId, proposalId: proposal.id, actor: 'tester', execute: true });
  assert.equal(result.payments[0].idempotentReplay, true);
  assert.equal(calls.length, 0);
});

test('rejecting one proposal keeps the transfer open and hides only that candidate', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  store.upsertInvoice({ ...invoice, id: 'inv2', number: 'LAG-2', customerId: 'cus2', customerName: 'Other Acme' });
  const transferId = service.ingestTransfer({ ...transfer, reference: 'SERVICES' });
  const before = store.listProposals(transferId);
  service.reject({ transferId, proposalId: before[0].id, actor: 'tester', note: 'Wrong customer' });
  const item = store.listTransfers()[0];
  assert.equal(item.reviewStatus, 'unreviewed');
  assert.equal(item.proposals.length, before.length - 1);
  assert(!item.proposals.some((proposal) => proposal.id === before[0].id));
});

test('a reviewer can manually allocate an unmatched transfer to an open invoice', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const transferId = service.ingestTransfer({ ...transfer, reference: 'NO REFERENCE', senderName: 'Unrecognizable sender' });
  const result = await service.approve({
    transferId,
    allocations: [{ invoiceId: 'inv1', amountCents: 10000 }],
    actor: 'tester',
    note: 'Confirmed from remittance email',
    execute: true
  });
  assert.equal(result.dryRun, true);
  assert.equal(store.listTransfers()[0].reviewStatus, 'approved');
});

test('overpayment remains visible as unapplied cash instead of blocking a valid allocation', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const transferId = service.ingestTransfer({ ...transfer, amountCents: 12000 });
  const result = await service.approve({
    transferId, allocations: [{ invoiceId: 'inv1', amountCents: 10000 }], actor: 'tester'
  });
  assert.equal(result.unappliedAmountCents, 2000);
  const receipt = store.getReceipt(transferId);
  assert.equal(receipt.allocatedAmountCents, 10000);
  assert.equal(receipt.unappliedAmountCents, 2000);
  assert.equal(receipt.allocations[0].status, 'approved');
});

test('one receipt records auditable allocations across several invoices', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice({ ...invoice, totalAmountCents: 6000, remainingAmountCents: 6000 });
  store.upsertInvoice({ ...invoice, id: 'inv2', number: 'LAG-2', totalAmountCents: 4000, remainingAmountCents: 4000 });
  const transferId = service.ingestTransfer({ ...transfer, reference: 'monthly invoices' });
  await service.approve({
    transferId,
    allocations: [{ invoiceId: 'inv1', amountCents: 6000 }, { invoiceId: 'inv2', amountCents: 4000 }],
    actor: 'tester',
    note: 'Confirmed from remittance advice'
  });
  const receipt = store.getReceipt(transferId);
  assert.equal(receipt.allocations.length, 2);
  assert.equal(receipt.unappliedAmountCents, 0);
  assert.deepEqual(receipt.allocations.map((item) => item.invoiceId), ['inv1', 'inv2']);
});

test('a reviewed allocation can span more than three invoices', async (t) => {
  const { store, service } = setup(t);
  const allocations = [];
  for (let index = 1; index <= 8; index += 1) {
    const id = `many-${index}`;
    store.upsertInvoice({ ...invoice, id, number: `LAG-${index}`, totalAmountCents: 1250, remainingAmountCents: 1250 });
    allocations.push({ invoiceId: id, amountCents: 1250 });
  }
  const receiptId = service.ingestTransfer({ ...transfer, amountCents: 10000, reference: 'batch' });
  await service.approve({ transferId: receiptId, allocations, actor: 'tester' });
  assert.equal(store.getReceipt(receiptId).allocations.length, 8);
});

test('cited remittance text is verified, stored as claims, and rematched', (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const receiptId = service.ingestTransfer({ ...transfer, reference: 'batch from payer' });
  const excerpt = 'Invoice LAG-1 amount USD 100.00';
  const result = service.ingestRemittanceDocument(receiptId, {
    sourceSystem: 'gmail', sourceRecordId: 'message-1', mimeType: 'text/plain',
    extractor: 'test-extractor', content: `Payment advice\n${excerpt}`,
    claims: [{ invoiceNumber: 'LAG-1', amountCents: 10000, currency: 'USD', citation: { locator: 'body line 2', excerpt } }]
  }, 'tester');
  assert.equal(store.getReceipt(receiptId).remittanceClaims.length, 1);
  assert(result.proposals.some((item) => item.kind === 'remittance'));
  assert.throws(() => service.ingestRemittanceDocument(receiptId, {
    sourceSystem: 'gmail', sourceRecordId: 'message-2', mimeType: 'text/plain', extractor: 'test', content: 'different',
    claims: [{ invoiceNumber: 'LAG-1', amountCents: 10000, currency: 'USD', citation: { locator: 'body', excerpt } }]
  }, 'tester'), /excerpt must occur/);
});

test('typed settlement adjustments conserve cash and invoice value separately', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const policy = service.configureCashApplicationPolicy({ customerId: 'cus1', maxBankFeeCents: 150 }, 'admin');
  const receiptId = service.ingestTransfer({ ...transfer, amountCents: 9900 });
  const proposal = store.listProposals(receiptId).find((item) => item.kind === 'tolerance');
  assert(proposal);
  await service.approve({ transferId: receiptId, proposalId: proposal.id, actor: 'tester' });
  const receipt = store.getReceipt(receiptId);
  assert.equal(receipt.allocatedAmountCents, 9900);
  assert.equal(receipt.unappliedAmountCents, 0);
  assert.deepEqual(receipt.adjustments.map((item) => [item.type, item.amountCents, item.policyVersion]),
    [['bank_fee_writeoff', 100, policy.version]]);
  assert.equal(store.getInvoiceAllocationExposure('inv1').reservedAmountCents, 10000);
});

test('voiding an unexecuted approval releases capacity and prevents later execution', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const receiptId = service.ingestTransfer(transfer);
  const approval = await service.approve({ transferId: receiptId, proposalId: store.listProposals(receiptId)[0].id, actor: 'tester' });
  const decision = service.voidApproval({ decisionId: approval.decisionId, actor: 'tester', reason: 'Wrong invoice' });
  assert.equal(decision.execution_status, 'voided');
  assert.equal(store.getReceipt(receiptId).unappliedAmountCents, 10000);
  assert.equal(store.getInvoiceAllocationExposure('inv1').reservedAmountCents, 0);
  await assert.rejects(service.executeDecision(approval.decisionId, 'tester'), /voided approval/);
});

test('voiding a wrong-customer approval permits a corrected allocation', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  store.upsertInvoice({ ...invoice, id: 'inv2', number: 'LAG-2', customerId: 'cus2', customerName: 'Correct customer' });
  const receiptId = service.ingestTransfer(transfer);
  const approval = await service.approve({ transferId: receiptId, allocations: [{ invoiceId: 'inv1', amountCents: 10000 }], actor: 'tester' });
  service.voidApproval({ decisionId: approval.decisionId, actor: 'tester', reason: 'Wrong customer' });
  await service.approve({ transferId: receiptId, allocations: [{ invoiceId: 'inv2', amountCents: 10000 }], actor: 'tester' });
  assert.deepEqual(store.getReceipt(receiptId).allocations.map((item) => [item.invoiceId, item.status]),
    [['inv1', 'voided'], ['inv2', 'approved']]);
});

test('executed allocations reserve invoice value until Lago confirms the payment', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice(invoice);
  const live = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 10000 }),
      createPayment: async () => ({ lago_id: 'lago-payment-1' })
    }
  });
  const receiptId = live.ingestTransfer(transfer);
  const approval = await live.approve({ transferId: receiptId, proposalId: store.listProposals(receiptId)[0].id, actor: 'tester', execute: true });
  assert.equal(store.getReceipt(receiptId).allocations[0].status, 'executed');
  assert.equal(store.getInvoiceAllocationExposure('inv1').reservedAmountCents, 10000);
  store.upsertInvoice({ ...invoice, paymentStatus: 'succeeded', remainingAmountCents: 0 });
  store.upsertLagoPayment({ id: 'lago-payment-1', invoiceId: 'inv1', status: 'succeeded', amountCents: 10000,
    providerPaymentId: null, providerCode: 'manual', reference: null, paidAt: '2026-08-10' });
  assert.equal(store.getReceipt(receiptId).allocations[0].status, 'confirmed');
  assert.equal(store.getInvoiceAllocationExposure('inv1').reservedAmountCents, 0);
  assert.equal(approval.payments[0].lago_id, 'lago-payment-1');
});

test('voiding an executed approval requires a compensating reversal', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice(invoice);
  const live = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 10000 }),
      createPayment: async () => ({ lago_id: 'lago-payment-2' })
    }
  });
  const receiptId = live.ingestTransfer(transfer);
  const result = await live.approve({ transferId: receiptId, proposalId: store.listProposals(receiptId)[0].id, actor: 'tester', execute: true });
  const decisionId = store.db.prepare('SELECT id FROM decisions ORDER BY id DESC LIMIT 1').get().id;
  assert.equal(result.dryRun, false);
  assert.equal(live.voidApproval({ decisionId, actor: 'tester', reason: 'Bank return' }).execution_status, 'reversal_required');
  assert.equal(store.getReceipt(receiptId).allocations[0].status, 'reversal_required');
});

test('a returned receipt marks an executed Lago payment for compensating reversal', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice(invoice);
  const live = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 10000 }),
      createPayment: async () => ({ lago_id: 'lago-payment-returned' })
    }
  });
  const receiptId = live.ingestTransfer(transfer);
  await live.approve({ transferId: receiptId, proposalId: store.listProposals(receiptId)[0].id, actor: 'tester', execute: true });
  live.ingestTransfer({ ...transfer, status: 'reversed' });
  assert.equal(store.getReceipt(receiptId).allocations[0].status, 'reversal_required');
  assert.equal(store.getDecision(store.db.prepare('SELECT id FROM decisions ORDER BY id DESC LIMIT 1').get().id).execution_status,
    'reversal_required');
});

test('a reversal voids unexecuted work without erasing its history', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice);
  const transferId = service.ingestTransfer(transfer);
  const proposal = store.listProposals(transferId)[0];
  await service.approve({ transferId, proposalId: proposal.id, actor: 'tester' });
  service.ingestTransfer({ ...transfer, status: 'reversed' });
  const receipt = store.getReceipt(transferId);
  assert.equal(receipt.status, 'reversed');
  assert.equal(receipt.allocations[0].status, 'voided');
  assert.equal(store.listTransfers()[0].reviewStatus, 'exception');
});

test('a webhook is not marked processed when transaction retrieval fails', async (t) => {
  const { store } = setup(t);
  const failing = new ReconciliationService({
    store, dryRun: true, lago: {}, qonto: {},
    mercury: {
      verifyWebhook: () => true,
      getTransaction: async () => { throw new Error('temporary Mercury failure'); }
    }
  });
  const body = JSON.stringify({ id: 'evt1', resourceType: 'transaction', resourceId: 'txn1' });
  await assert.rejects(() => failing.processWebhook('mercury', body, 'valid'), /temporary Mercury failure/);
  assert.equal(store.hasWebhookEvent('mercury', 'evt1'), false);
});

test('non-transaction provider webhooks are acknowledged without transaction lookup', async (t) => {
  const { store } = setup(t);
  let lookups = 0;
  const service = new ReconciliationService({
    store, dryRun: true, lago: {}, mercury: {},
    qonto: {
      verifyWebhook: () => true,
      getTransaction: async () => { lookups += 1; throw new Error('must not be called'); }
    }
  });
  const body = JSON.stringify({ id: 'evt-account', type: 'v1/accounts', data: { id: 'account-1', event: 'updated' } });
  assert.deepEqual(await service.processWebhook('qonto', body, 'valid'), { accepted: true, ignored: true });
  assert.equal(lookups, 0);
  assert.equal(store.hasWebhookEvent('qonto', 'evt-account'), true);
});

test('live execution stops if the Lago balance changed after approval', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice(invoice);
  const live = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 5000 }),
      createPayment: async () => { throw new Error('must not be called'); }
    }
  });
  const transferId = live.ingestTransfer(transfer);
  const proposal = store.listProposals(transferId)[0];
  await assert.rejects(() => live.approve({ transferId, proposalId: proposal.id, actor: 'tester', execute: true }), /balance changed/);
});

test('live split execution is blocked until Lago exposes one atomic command', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice({ ...invoice, totalAmountCents: 6000, remainingAmountCents: 6000 });
  store.upsertInvoice({ ...invoice, id: 'inv2', number: 'LAG-2', totalAmountCents: 4000, remainingAmountCents: 4000 });
  const writes = [];
  const live = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async () => null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 6000 }),
      createPayment: async (payload) => { writes.push(payload); return payload; }
    }
  });
  const transferId = live.ingestTransfer({ ...transfer, reference: 'August invoices' });
  await assert.rejects(() => live.approve({
    transferId,
    allocations: [{ invoiceId: 'inv1', amountCents: 6000 }, { invoiceId: 'inv2', amountCents: 4000 }],
    actor: 'tester', execute: true
  }), /atomic Lago allocation command/);
  assert.equal(writes.length, 0);
});

test('only finalized Lago invoices can be matched or allocated', async (t) => {
  const { store, service } = setup(t);
  for (const status of ['draft', 'voided', 'failed', 'pending']) {
    store.upsertInvoice({ ...invoice, id: `inv-${status}`, number: `LAG-${status}`, status });
  }
  assert.deepEqual(store.getOpenInvoices(), []);
  const id = service.ingestTransfer({ ...transfer, reference: 'LAG-draft' });
  assert.deepEqual(store.listProposals(id), []);
  await assert.rejects(service.approve({ transferId: id, allocations: [{ invoiceId: 'inv-draft', amountCents: 10000 }], actor: 'reviewer' }), /not open/);
  store.upsertInvoice(invoice);
  assert.deepEqual(store.getOpenInvoices().map((item) => item.id), ['inv1']);
});

test('two partial allocations of one receipt to one invoice both reach Lago', async (t) => {
  const { store } = setup(t);
  store.upsertInvoice({ ...invoice, totalAmountCents: 1200, remainingAmountCents: 1200 });
  const lagoPayments = [];
  const liveService = new ReconciliationService({
    store, dryRun: false, mercury: {}, qonto: {},
    lago: {
      findPaymentByReference: async (invoiceId, reference) => lagoPayments.find((p) => p.invoiceId === invoiceId && p.reference === reference) ?? null,
      getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 1200 - lagoPayments.reduce((sum, p) => sum + p.amountCents, 0) }),
      createPayment: async (payload) => { lagoPayments.push(payload); return payload; }
    }
  });
  const transferId = liveService.ingestTransfer({ ...transfer, amountCents: 1200 });
  const allocations = [{ invoiceId: 'inv1', amountCents: 600 }];
  const first = await liveService.approve({ transferId, allocations, actor: 'tester', execute: true });
  const second = await liveService.approve({ transferId, allocations, actor: 'tester', execute: true });
  assert.equal(first.payments[0].idempotentReplay, undefined);
  assert.equal(second.payments[0].idempotentReplay, undefined);
  assert.deepEqual(lagoPayments.map((p) => p.amountCents), [600, 600]);
  assert.notEqual(lagoPayments[0].reference, lagoPayments[1].reference);
});
