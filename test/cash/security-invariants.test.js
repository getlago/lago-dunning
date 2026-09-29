import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../../src/cash/config.js';
import { requestJson } from '../../src/cash/connectors/http.js';
import { ReconciliationStore } from '../../src/cash/db.js';
import { authorizeLocalRequest } from '../../src/cash/local-auth.js';
import { redactSensitive } from '../../src/cash/redaction.js';
import { ReconciliationService } from '../../src/cash/service.js';

const invoice = (id = 'inv1', customerId = 'cus1', amount = 10000) => ({
  id, number: `LAG-${id}`, customerId, customerName: customerId, currency: 'USD',
  totalAmountCents: amount, remainingAmountCents: amount, status: 'finalized', paymentStatus: 'pending', issuedAt: '2026-08-01'
});
const transfer = (id = 'txn1', amount = 10000, status = 'posted') => ({
  provider: 'brex', accountId: 'cash1', providerTransactionId: id, status, direction: 'credit',
  amountCents: amount, currency: 'USD', bookedAt: '2026-08-10', senderName: 'Acme', reference: 'LAG'
});

function setup(t, { dryRun = true, lago = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-safety-'));
  const store = new ReconciliationStore(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  return { store, service: new ReconciliationService({ store, dryRun, lago, mercury: {}, qonto: {} }) };
}

function request(remoteAddress, adminKey = null, host = '127.0.0.1:4310') {
  return {
    headers: { host, ...(adminKey ? { 'x-admin-key': adminKey, 'x-actor': 'spoofed-user' } : {}) },
    socket: { remoteAddress }
  };
}

test('the local API fails closed outside loopback and never trusts a supplied actor', () => {
  const demo = { dryRun: true, adminKeys: [] };
  const principal = authorizeLocalRequest(request('127.0.0.1'), demo);
  assert.equal(principal.actor, 'local-demo-user');
  assert.equal(authorizeLocalRequest(request('::1', null, '[::1]:4310'), demo).authenticatedBy, 'loopback_dry_run');
  assert.throws(() => authorizeLocalRequest(request('10.0.0.8'), demo), /restricted to loopback/);
  assert.throws(() => authorizeLocalRequest(request('127.0.0.1', null, 'attacker.example'), demo), /restricted to loopback/);
  assert.throws(() => authorizeLocalRequest({
    headers: { host: '127.0.0.1:4310', 'x-forwarded-for': '203.0.113.8' }, socket: { remoteAddress: '127.0.0.1' }
  }, demo), /restricted to loopback/);

  const protectedConfig = { dryRun: true, adminKeys: ['correct-key'] };
  assert.throws(() => authorizeLocalRequest(request('127.0.0.1', 'wrong-key'), protectedConfig), /valid x-admin-key/);
  const admin = authorizeLocalRequest(request('10.0.0.8', 'correct-key'), protectedConfig);
  assert.match(admin.actor, /^local-admin:/);
  assert.notEqual(admin.actor, 'spoofed-user');
});

test('configuration refuses live or externally bound operation without an access key', () => {
  assert.throws(() => loadConfig({ env: { DRY_RUN: 'false', ADMIN_KEYS: '', HOST: '127.0.0.1' } }), /ADMIN_KEYS is required/);
  assert.throws(() => loadConfig({ env: { DRY_RUN: 'true', ADMIN_KEYS: '', HOST: '0.0.0.0' } }), /ADMIN_KEYS is required/);
});

test('provider requests time out instead of hanging an agent run forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 100);
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  });
  try {
    await assert.rejects(requestJson('https://provider.invalid', { timeoutMs: 5 }), /timed out after 5ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stored raw evidence redacts credentials and bank account identifiers', (t) => {
  const { store, service } = setup(t);
  service.ingestTransfer({ ...transfer(), raw: {
    id: 'txn1', authorization: 'Bearer secret', counterparty: { account_number: '123456789', iban: 'FR76123' }
  } });
  const raw = store.db.prepare('SELECT raw_json FROM transfers WHERE id=?').get('brex:cash1:txn1').raw_json;
  assert(!raw.includes('Bearer secret'));
  assert(!raw.includes('123456789'));
  assert(!raw.includes('FR76123'));
  assert.equal(redactSensitive({ accessToken: 'secret', nested: { routing_number: '021000021' } }).accessToken, '[REDACTED]');
  const values = redactSensitive('IBAN DE89370400440532013000, ABA 021000021, card 4111 1111 1111 1111');
  assert(!values.includes('DE89370400440532013000'));
  assert(!values.includes('021000021'));
  assert(!values.includes('4111 1111 1111 1111'));
  assert(!redactSensitive('IBAN DE89 3704 0044 0532 0130 00').includes('DE89 3704'));
});

test('unsettled receipts are ignored and reversed receipts cannot be executed', async (t) => {
  const writes = [];
  const { store, service } = setup(t, { dryRun: false, lago: {
    findPaymentByReference: async () => null,
    getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 10000 }),
    createPayment: async (payload) => { writes.push(payload); return payload; }
  } });
  store.upsertInvoice(invoice());
  const pendingId = service.ingestTransfer(transfer('pending', 10000, 'pending'));
  assert.equal(pendingId, null);
  assert.equal(store.listReceipts().length, 0);

  const receiptId = service.ingestTransfer(transfer());
  const proposal = store.listProposals(receiptId)[0];
  const approved = await service.approve({ transferId: receiptId, proposalId: proposal.id, actor: 'reviewer' });
  service.ingestTransfer({ ...transfer(), status: 'reversed' });
  await assert.rejects(service.executeDecision(approved.decisionId, 'reviewer'), /voided approval/);
  assert.equal(writes.length, 0);
});

test('allocations conserve receipt value and reserve invoice value across decisions', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice('inv1', 'cus1', 10000));
  store.upsertInvoice(invoice('inv2', 'cus1', 10000));
  const firstReceipt = service.ingestTransfer(transfer('first', 12000));
  await service.approve({ transferId: firstReceipt, allocations: [{ invoiceId: 'inv1', amountCents: 6000 }], actor: 'reviewer' });
  await assert.rejects(service.approve({
    transferId: firstReceipt, allocations: [{ invoiceId: 'inv2', amountCents: 7000 }], actor: 'reviewer'
  }), /unapplied amount/);

  const secondReceipt = service.ingestTransfer(transfer('second', 6000));
  await assert.rejects(service.approve({
    transferId: secondReceipt, allocations: [{ invoiceId: 'inv1', amountCents: 5000 }], actor: 'reviewer'
  }), /Invalid allocation amount/);

  assert.throws(() => store.decide({
    transferId: firstReceipt, action: 'approve', allocations: [{ invoiceId: 'inv2', amountCents: 7000 }], actor: 'bypass'
  }), /exceeds receipt value/);
});

test('settlement policy cannot be bypassed with partial or duplicate adjustments', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice('inv1', 'cus1', 10000));
  const policy = service.configureCashApplicationPolicy({ customerId: 'cus1', maxBankFeeCents: 100 }, 'admin');
  const receiptId = service.ingestTransfer(transfer('fee', 9900));
  await assert.rejects(service.approve({
    transferId: receiptId, allocations: [{ invoiceId: 'inv1', amountCents: 9800 }],
    adjustments: [{ invoiceId: 'inv1', type: 'bank_fee_writeoff', amountCents: 100, currency: 'USD', policyVersion: policy.version }],
    actor: 'reviewer'
  }), /close the available invoice balance/);
  assert.throws(() => store.decide({
    transferId: receiptId, action: 'approve', allocations: [{ invoiceId: 'inv1', amountCents: 9800 }],
    adjustments: [{ invoiceId: 'inv1', type: 'bank_fee_writeoff', amountCents: 200, currency: 'USD', policyVersion: policy.version }],
    actor: 'bypass'
  }), /exceeds the configured customer policy/);
  await assert.rejects(service.approve({
    transferId: receiptId, allocations: [{ invoiceId: 'inv1', amountCents: 9900 }],
    adjustments: [
      { invoiceId: 'inv1', type: 'bank_fee_writeoff', amountCents: 50, currency: 'USD', policyVersion: policy.version },
      { invoiceId: 'inv1', type: 'bank_fee_writeoff', amountCents: 50, currency: 'USD', policyVersion: policy.version }
    ], actor: 'reviewer'
  }), /at most one settlement adjustment/);
});

test('one receipt cannot cross customers and live splits cannot create partial writes', async (t) => {
  const writes = [];
  const { store, service } = setup(t, { dryRun: false, lago: {
    findPaymentByReference: async () => null,
    getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 5000 }),
    createPayment: async (payload) => { writes.push(payload); return payload; }
  } });
  store.upsertInvoice(invoice('inv1', 'cus1', 5000));
  store.upsertInvoice(invoice('inv2', 'cus2', 5000));
  const receiptId = service.ingestTransfer(transfer('split', 10000));
  await assert.rejects(service.approve({
    transferId: receiptId,
    allocations: [{ invoiceId: 'inv1', amountCents: 5000 }, { invoiceId: 'inv2', amountCents: 5000 }],
    actor: 'reviewer', execute: true
  }), /different Lago customers/);
  assert.equal(writes.length, 0);
});

test('decision execution has an atomic claim that blocks concurrent writers', async (t) => {
  let release;
  const writes = [];
  const { store, service } = setup(t, { dryRun: false, lago: {
    findPaymentByReference: async () => null,
    getInvoice: async () => ({ paymentStatus: 'pending', remainingAmountCents: 10000 }),
    createPayment: async (payload) => {
      writes.push(payload);
      await new Promise((resolve) => { release = resolve; });
      return { id: 'payment-1' };
    }
  } });
  store.upsertInvoice(invoice());
  const receiptId = service.ingestTransfer(transfer());
  const proposal = store.listProposals(receiptId)[0];
  const approval = await service.approve({ transferId: receiptId, proposalId: proposal.id, actor: 'reviewer' });
  const first = service.executeDecision(approval.decisionId, 'reviewer');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.executeDecision(approval.decisionId, 'reviewer'), /already in progress/);
  release();
  await first;
  assert.equal(writes.length, 1);
});

test('an abandoned execution lease can be reclaimed but an active one cannot', async (t) => {
  const { store, service } = setup(t);
  store.upsertInvoice(invoice());
  const receiptId = service.ingestTransfer(transfer());
  const approval = await service.approve({ transferId: receiptId, proposalId: store.listProposals(receiptId)[0].id, actor: 'reviewer' });
  assert.equal(store.claimDecisionExecution(approval.decisionId, 'worker-a', 30), true);
  assert.equal(store.claimDecisionExecution(approval.decisionId, 'worker-b', 30), false);
  store.db.prepare("UPDATE decisions SET execution_claimed_at=datetime('now', '-31 seconds') WHERE id=?").run(approval.decisionId);
  assert.equal(store.claimDecisionExecution(approval.decisionId, 'worker-b', 30), true);
  assert.equal(store.getDecision(approval.decisionId).execution_attempts, 2);
});
