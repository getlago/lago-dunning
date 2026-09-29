import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReconciliationAgent } from './agent/orchestrator.js';
import { evaluateAgent } from './agent/evaluation.js';
import { ReconciliationStore } from './db.js';
import { ReconciliationService } from './service.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-agent-eval-'));
const store = new ReconciliationStore(path.join(directory, 'evaluation.db'));
const service = new ReconciliationService({ store, lago: {}, mercury: {}, qonto: {}, dryRun: true });
const agent = new ReconciliationAgent({ store, service });

const invoices = [
  invoice('exact', 'LAG-EXACT', 'Acme', 125000),
  invoice('amb-a', 'LAG-AMB-A', 'North One', 48000),
  invoice('amb-b', 'LAG-AMB-B', 'North Two', 48000),
  invoice('parent', 'LAG-PARENT', 'Orbit France', 133700),
  invoice('split-a', 'LAG-SPLIT-A', 'Helios', 30000),
  invoice('split-b', 'LAG-SPLIT-B', 'Helios', 42500)
];
invoices.forEach((item) => store.upsertInvoice(item));
store.upsertCustomerContext({
  source: 'salesforce', crmAccountId: 'sf-orbit', lagoCustomerId: 'parent-customer', accountName: 'Orbit France',
  parentCrmAccountId: 'sf-orbit-parent', parentName: 'Orbit Holdings', ownerName: 'Account Owner', aliases: []
});

[
  transfer('exact', 125000, 'Acme', 'LAG-EXACT'),
  transfer('ambiguous', 48000, 'WIRE TRANSFER', 'SERVICES'),
  transfer('parent', 133700, 'Orbit Holdings', 'August services'),
  transfer('split', 72500, 'Helios', 'LAG-SPLIT-A LAG-SPLIT-B'),
  transfer('currency', 125000, 'Acme', 'LAG-EXACT', { currency: 'EUR' }),
  transfer('reversal', 9900, 'Returned payer', 'RETURN', { status: 'reversed' })
].forEach((item) => service.ingestTransfer(item));

try {
  const run = await agent.run({ trigger: 'evaluation', sync: false });
  const report = evaluateAgent(run.cases, [
    expected('exact', 'safe_match', 'ready_for_approval'),
    expected('ambiguous', 'ambiguous_match', 'needs_remittance'),
    expected('parent', 'suggested_match', 'needs_review'),
    expected('split', 'split_allocation', 'needs_review'),
    expected('currency', 'unmatched_receipt', 'needs_remittance'),
    expected('reversal', 'receipt_reversal', 'blocked')
  ], run.summary);
  console.log(JSON.stringify(report, null, 2));
  if (report.scenarioAccuracy !== 1 || report.groundedEvidenceRate !== 1 || report.traceCoverage !== 1 || report.unsafeFinancialWrites !== 0) process.exitCode = 1;
} finally {
  store.close();
  fs.rmSync(directory, { recursive: true });
}

function invoice(id, number, customerName, amountCents) {
  const customerId = id === 'parent' ? 'parent-customer' : id.startsWith('split') ? 'helios' : `${id}-customer`;
  return { id: `inv-${id}`, number, customerId, customerName, currency: 'USD', totalAmountCents: amountCents, remainingAmountCents: amountCents, status: 'finalized', paymentStatus: 'pending', issuedAt: '2026-08-01' };
}

function transfer(id, amountCents, senderName, reference, overrides = {}) {
  return { provider: 'mercury', accountId: 'eval', providerTransactionId: id, status: 'posted', direction: 'credit', amountCents, currency: 'USD', bookedAt: '2026-08-10', senderName, reference, ...overrides };
}

function expected(id, kind, disposition) {
  return { caseKey: `receipt:mercury:eval:${id}`, kind, disposition, queue: 'cash_application' };
}
