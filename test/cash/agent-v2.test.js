import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReconciliationAgent } from '../../src/cash/agent/orchestrator.js';
import { AgentWorker } from '../../src/cash/agent/worker.js';
import { ReconciliationStore } from '../../src/cash/db.js';
import { ReconciliationService } from '../../src/cash/service.js';

const invoice = { id: 'inv1', number: 'LAG-1', customerId: 'cus1', customerName: 'Acme France', currency: 'USD', totalAmountCents: 10000, remainingAmountCents: 10000, status: 'finalized', paymentStatus: 'pending', issuedAt: '2026-08-01' };
const transfer = { provider: 'mercury', accountId: 'acc1', providerTransactionId: 'txn1', status: 'posted', direction: 'credit', amountCents: 10000, currency: 'USD', bookedAt: '2026-08-10', senderName: 'Acme France', reference: 'LAG-1' };

function setup(t, overrides = {}, agentConfig = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-agent-v2-'));
  const store = new ReconciliationStore(path.join(directory, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true }); });
  const service = new ReconciliationService({ store, dryRun: true, lago: {}, mercury: {}, qonto: {}, ...overrides });
  const agent = new ReconciliationAgent({ store, service, config: agentConfig });
  return { store, service, agent };
}

test('autonomous run leaves a durable tool trace and a source-cited ready-for-approval case', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  const result = await agent.run({ trigger: 'test', sync: false });
  assert.equal(result.status, 'completed');
  assert(result.steps.some((step) => step.toolName === 'rematch_receipts' && step.status === 'succeeded'));
  assert(result.steps.some((step) => step.toolName === 'investigate_exceptions'));
  assert.equal(result.summary.financialWrites, 0);
  assert.equal(result.summary.controls.approvalRequired, true);
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].disposition, 'ready_for_approval');
  assert(result.cases[0].evidence.some((item) => item.citation === 'lago:invoice:inv1'));
  assert(result.cases[0].evidence.some((item) => item.authority === 'receipt_authority'));
  assert(result.cases[0].trace.length >= 5);
});

test('cases retain identity across runs and clear only after an approved action', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  const first = await agent.run({ sync: false });
  const second = await agent.run({ sync: false });
  assert.equal(first.cases[0].id, second.cases[0].id);
  assert.equal(store.listAgentCases('open').length, 1);
  await assert.rejects(agent.act(first.cases[0].id, { action: 'dismiss', actor: 'viewer' }), /payments:view/);
  await assert.rejects(agent.act(first.cases[0].id, { action: 'approve', actor: 'viewer', actorPermissions: ['payments:view'] }), /payments:create/);
  const action = await agent.act(first.cases[0].id, { action: 'approve', actor: 'reviewer', actorPermissions: ['payments:create'], execute: false });
  assert.equal(action.case.state, 'resolved');
  assert.equal(action.decision.executionStatus, 'not_requested');
  assert.equal(store.listAllocations(first.cases[0].action.payload.transferId).length, 1);
  await assert.rejects(agent.act(first.cases[0].id, {
    action: 'approve', actor: 'reviewer', actorPermissions: ['payments:create']
  }), /not actionable/);
});

test('reviewer rejection is recorded and reported in shadow-mode metrics', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  const run = await agent.run({ sync: false });
  await agent.act(run.cases[0].id, {
    action: 'reject', actor: 'reviewer', actorPermissions: ['payments:view'], note: 'Wrong payer'
  });
  const metrics = store.getAgentOutcomeMetrics();
  assert.equal(metrics.reviewedCases, 1);
  assert.equal(metrics.rejectedCases, 1);
  assert.equal(metrics.reviewerAcceptanceRate, 0);
});

test('reviewer labels produce real precision, time-saved metrics, and conservative readiness', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  const run = await agent.run({ sync: false });
  const result = await agent.act(run.cases[0].id, {
    action: 'label', actor: 'reviewer', actorPermissions: ['payments:view'], verdict: 'correct',
    expectedAllocations: run.cases[0].action.payload.allocations, reviewSeconds: 20, baselineSeconds: 120,
    note: 'Confirmed against bank statement'
  });
  assert.equal(result.financialWrite, false);
  assert.equal(result.case.state, 'open');
  const metrics = store.getAgentOutcomeMetrics();
  assert.equal(metrics.metricsScope, 'current_policy');
  assert.equal(metrics.policyVersion, run.policyVersion);
  assert.equal(metrics.labeledReadyCases, 1);
  assert.equal(metrics.labeledPrecision, 1);
  assert.equal(metrics.medianSecondsSaved, 100);
  const readiness = store.getPilotReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.productionReady, false);
  assert.equal(readiness.automationEligible, false);
  assert.equal(readiness.gates.find((gate) => gate.id === 'labeled_sample').passed, false);
  const newPolicyRun = store.startAgentRun({ trigger: 'policy-change', policyVersion: 'future-policy', sourcePlan: [] });
  store.finishAgentRun(newPolicyRun, 'completed', { financialWrites: 0 });
  assert.equal(store.getAgentOutcomeMetrics().labeledReadyCases, 0);
});

test('linked Ramp remittance appears in the Brex case workpaper as corroboration only', async (t) => {
  const { service, agent } = setup(t);
  service.store.upsertInvoice(invoice);
  const receiptId = service.ingestTransfer({ ...transfer, provider: 'brex', accountId: 'destination' });
  service.attachReceiptEvidence(receiptId, {
    sourceSystem: 'ramp', sourceRecordId: 'ramp-payment', relation: 'payer_remittance',
    direction: 'debit', authority: 'remittance_only', amountCents: 10000, currency: 'USD',
    metadata: { amountCents: 999999, direction: 'credit' }
  }, 'reviewer');
  const run = await agent.run({ sync: false });
  const item = run.cases[0];
  assert(item.evidence.some((evidence) => evidence.citation === 'ramp:linked_evidence:ramp-payment'));
  assert(item.evidence.some((evidence) => evidence.authority === 'remittance_only'));
  assert.equal(item.evidence.filter((evidence) => evidence.authority === 'receipt_authority').length, 1);
  const linked = item.evidence.find((evidence) => evidence.citation === 'ramp:linked_evidence:ramp-payment');
  assert.equal(linked.fields.amountCents, 10000);
  assert.equal(linked.fields.direction, 'debit');
});

test('Salesforce owner stays commercial context while the configured operator queue owns the case', async (t) => {
  const { store, service, agent } = setup(t, {}, { operatorQueue: 'billing_ops', operatorLabel: 'Billing operations' });
  store.upsertInvoice(invoice);
  store.upsertCustomerContext({
    source: 'salesforce', crmAccountId: '001', lagoCustomerId: 'cus1', erpCustomerId: 'NS-7',
    accountName: 'Acme France', parentCrmAccountId: 'parent', parentName: 'Acme Holdings',
    ownerName: 'Account Owner', aliases: ['Acme Treasury']
  });
  service.ingestTransfer({ ...transfer, senderName: 'Acme Holdings', reference: 'August services' });
  const result = await agent.run({ sync: false });
  const item = result.cases[0];
  assert.equal(item.assignment.queue, 'billing_ops');
  assert.equal(item.ownerName, 'Billing operations');
  assert.equal(item.assignment.commercialOwnerName, 'Account Owner');
  assert.equal(item.assignment.requiredPermission, 'payments:create');
  assert.notEqual(item.disposition, 'ready_for_approval');
  const edges = store.listIdentityEdges();
  assert(edges.some((edge) => edge.edgeType === 'crm_to_lago_customer'));
  assert(edges.some((edge) => edge.edgeType === 'crm_to_erp_customer'));
  assert(edges.some((edge) => edge.edgeType === 'subsidiary_to_parent'));
});

test('Lago customer external_salesforce_id links CRM context without a duplicate mapping', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice({ ...invoice, customerExternalSalesforceId: '001' });
  store.upsertCustomerContext({
    source: 'salesforce', crmAccountId: '001', lagoCustomerId: null,
    accountName: 'Acme France', ownerName: 'Account Owner', aliases: []
  });
  service.ingestTransfer(transfer);
  const run = await agent.run({ sync: false });
  assert.equal(run.cases[0].assignment.commercialOwnerName, 'Account Owner');
  assert(store.listIdentityEdges().some((edge) => edge.edgeType === 'crm_to_lago_customer' && edge.toId === 'cus1'));
});

test('versioned playbooks add reusable review controls but cannot promote unsafe matches', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  store.upsertAgentPlaybook({
    id: 'large-wire-control', name: 'Large wire dual evidence', createdBy: 'controller',
    conditions: { providers: ['mercury'], minAmountCents: 5000 },
    effects: { priority: 'high', blockReadyForApproval: true, requireAuthorities: ['accounting_evidence'], reviewSteps: ['Confirm in ERP'] }
  });
  const updated = store.upsertAgentPlaybook({
    id: 'large-wire-control', name: 'Large wire dual evidence', createdBy: 'controller',
    conditions: { providers: ['mercury'], minAmountCents: 5000 },
    effects: { priority: 'critical', blockReadyForApproval: true, requireAuthorities: ['accounting_evidence'], reviewSteps: ['Confirm in ERP', 'Obtain controller sign-off'] }
  });
  assert.equal(updated.version, 2);
  const run = await agent.run({ sync: false });
  const item = run.cases[0];
  assert.equal(run.summary.playbookApplications, 1);
  assert.equal(item.priority, 'critical');
  assert.equal(item.disposition, 'blocked');
  assert.equal(item.action.type, 'collect_missing_evidence');
  assert(item.trace.some((step) => step.step === 'playbook:large-wire-control:v2'));
});

test('source failures are isolated, cited as coverage gaps, and do not abort investigation', async (t) => {
  const { store, service, agent } = setup(t, {
    mercury: { agentConfigured: true, listIncoming: async () => { throw new Error('bank unavailable'); } }
  });
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  const result = await agent.run({ sources: ['mercury'] });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary.sourceFailures, 1);
  assert(result.steps.some((step) => step.toolName === 'sync_mercury' && step.status === 'failed'));
  assert.equal(result.cases[0].sourceCoverage.mercury, 'failed');
  // A source that failed must still be named in the rationale, so a reader knows the
  // conclusion was reached without it.
  assert.match(result.cases[0].rationale, /Not cross-checked against[^.]*mercury/);
});

test('continuous Mercury and Qonto reads advance watermarks only after successful sync', async (t) => {
  const options = [];
  const { store, agent } = setup(t, {
    mercury: { agentConfigured: true, listIncoming: async (input) => { options.push(input); return []; } }
  });
  await agent.run({ sources: ['mercury'] });
  const firstState = store.getSyncState('mercury');
  assert(firstState.lastSyncedAt);
  await agent.run({ sources: ['mercury'] });
  assert.equal(options[0].postedStart, undefined);
  assert.equal(options[1].postedStart, firstState.lastSyncedAt);
});

test('reasoning failures fail the run instead of resolving open cases from an empty result', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  service.ingestTransfer(transfer);
  await agent.run({ sync: false });
  assert.equal(store.listAgentCases('open').length, 1);
  const original = store.listTransfers.bind(store);
  store.listTransfers = () => { throw new Error('corrupt local projection'); };
  await assert.rejects(agent.run({ sync: false }), /rematch_receipts failed/);
  store.listTransfers = original;
  assert.equal(store.getLatestAgentRun().status, 'failed');
  assert.equal(store.listAgentCases('open').length, 1);
});

test('remittance action drafts evidence-specific outreach but never sends it', async (t) => {
  const { service, agent } = setup(t);
  service.ingestTransfer({ ...transfer, providerTransactionId: 'unknown', senderName: 'Unknown Treasury', reference: 'SERVICES' });
  const run = await agent.run({ sync: false });
  const item = run.cases.find((candidate) => candidate.action.type === 'request_remittance');
  assert(item);
  const result = await agent.act(item.id, { action: 'draft_remittance', actor: 'collector', actorPermissions: ['payments:view'] });
  assert.equal(result.sent, false);
  assert.match(result.draft.body, /We received/);
  assert(result.case.events.some((event) => event.eventType === 'remittance_drafted'));
});

test('verified remittance claims become an approval case instead of another remittance request', async (t) => {
  const { store, service, agent } = setup(t);
  store.upsertInvoice(invoice);
  const receiptId = service.ingestTransfer({ ...transfer, reference: 'payment batch', senderName: 'Treasury account' });
  const excerpt = 'LAG-1 USD 100.00';
  service.ingestRemittanceDocument(receiptId, {
    sourceSystem: 'email', sourceRecordId: 'mail-1', mimeType: 'text/plain', extractor: 'fixture', content: excerpt,
    claims: [{ invoiceNumber: 'LAG-1', amountCents: 10000, currency: 'USD', citation: { locator: 'body line 1', excerpt } }]
  }, 'reviewer');
  const run = await agent.run({ sync: false });
  const item = run.cases.find((candidate) => candidate.caseKey === `receipt:${receiptId}`);
  assert.equal(item.kind, 'remittance_allocation');
  assert.equal(item.action.type, 'approve_allocation');
  assert(item.evidence.some((evidence) => evidence.authority === 'remittance_only' && evidence.entityType === 'claim'));
});

test('worker coalesces triggers while one investigation is running', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = new AgentWorker({ agent: { run: async () => { runs += 1; if (runs === 1) await gate; } }, intervalMs: 60_000 });
  const first = worker.trigger('first');
  worker.trigger('second');
  worker.trigger('third');
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  await worker.inFlight;
  assert.equal(runs, 2);
});
