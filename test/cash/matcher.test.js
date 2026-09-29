import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeMatches, scoreInvoice } from '../../src/cash/matcher.js';

const invoice = (overrides = {}) => ({
  id: 'inv_1', number: 'LAG-2026-1042', customerId: 'cus_1', customerName: 'Acme, Inc.',
  currency: 'USD', totalAmountCents: 125000, remainingAmountCents: 125000,
  paymentStatus: 'pending', issuedAt: '2026-07-20', ...overrides
});
const transfer = (overrides = {}) => ({
  provider: 'mercury', accountId: 'acc_1', providerTransactionId: 'txn_1', status: 'posted',
  amountCents: 125000, currency: 'USD', bookedAt: '2026-08-05', senderName: 'ACME INC',
  reference: 'Wire LAG 2026 1042', ...overrides
});

test('exact invoice reference and amount produce an automatic match', () => {
  const proposals = proposeMatches(transfer(), [invoice()]);
  assert.equal(proposals[0].invoiceIds[0], 'inv_1');
  assert.equal(proposals[0].autoEligible, true);
  assert.equal(proposals[0].confidence, 'automatic');
});

test('missing reference can become automatic only with a confirmed sender account', () => {
  const payment = transfer({ reference: 'AUGUST SOFTWARE', senderName: 'Wire transfer', senderAccountFingerprint: 'bank_1' });
  const withoutIdentity = proposeMatches(payment, [invoice()], []);
  assert.equal(withoutIdentity[0].autoEligible, false);
  const withIdentity = proposeMatches(payment, [invoice()], [{ fingerprint: 'bank_1', customerId: 'cus_1' }]);
  assert.equal(withIdentity[0].autoEligible, true);
  assert(withIdentity[0].signals.some((item) => item.code === 'identity_confirmed'));
});

test('mistyped reference is surfaced as evidence but never auto-applied by itself', () => {
  const proposals = proposeMatches(transfer({ reference: 'LAG-2026-1402' }), [invoice()]);
  assert.equal(proposals[0].autoEligible, false);
  assert(proposals[0].signals.some((item) => item.code.startsWith('reference_')));
});

test('a longer invoice reference cannot authorize a shorter invoice by substring', () => {
  const proposals = proposeMatches(
    transfer({ reference: 'Wire for INV-123', amountCents: 10000 }),
    [invoice({ id: 'short', number: 'INV-12', totalAmountCents: 10000, remainingAmountCents: 10000 })]
  );
  assert.equal(proposals[0].autoEligible, false);
  assert.notEqual(proposals[0].signals.find((item) => item.code.startsWith('reference_')).code, 'reference_contained');
});

test('invoice reference matching tolerates delimiters without losing identifier boundaries', () => {
  const proposals = proposeMatches(
    transfer({ reference: 'Wire for INV-12', amountCents: 10000 }),
    [invoice({ id: 'delimited', number: 'INV12', totalAmountCents: 10000, remainingAmountCents: 10000 })]
  );
  assert.equal(proposals[0].signals.find((item) => item.code.startsWith('reference_')).code, 'reference_contained');
  assert.equal(proposals[0].autoEligible, true);
});

test('same amount on two invoices remains ambiguous', () => {
  const invoices = [invoice(), invoice({ id: 'inv_2', number: 'LAG-2026-1050', customerId: 'cus_2', customerName: 'Acme Robotics' })];
  const proposals = proposeMatches(transfer({ reference: 'SERVICES', senderName: 'ACME' }), invoices);
  assert.equal(proposals[0].autoEligible, false);
  assert(proposals[0].margin < 15);
});

test('one transfer can be proposed as an exact split across invoices for one customer', () => {
  const invoices = [
    invoice({ id: 'inv_a', number: 'LAG-1', totalAmountCents: 30000, remainingAmountCents: 30000, customerName: 'Helios Cloud', customerId: 'helios' }),
    invoice({ id: 'inv_b', number: 'LAG-2', totalAmountCents: 42500, remainingAmountCents: 42500, customerName: 'Helios Cloud', customerId: 'helios' })
  ];
  const proposals = proposeMatches(transfer({ amountCents: 72500, senderName: 'HELIOS CLOUD', reference: 'JULY AND AUGUST' }), invoices);
  const split = proposals.find((item) => item.kind === 'split');
  assert(split);
  assert.equal(split.allocations.length, 2);
  assert.equal(split.allocations.reduce((sum, item) => sum + item.amountCents, 0), 72500);
  assert.equal(split.autoEligible, false);
});

test('an exact split can span more than three invoices without a schema ceiling', () => {
  const invoices = Array.from({ length: 8 }, (_, index) => invoice({
    id: `inv_${index + 1}`, number: `LAG-${index + 1}`, customerId: 'many', customerName: 'Many Corp',
    totalAmountCents: 1000, remainingAmountCents: 1000
  }));
  const proposals = proposeMatches(transfer({ amountCents: 8000, senderName: 'Many Corp', reference: 'August invoices' }), invoices);
  const split = proposals.find((item) => item.kind === 'split');
  assert.equal(split.allocations.length, 8);
  assert.equal(split.autoEligible, false);
});

test('cited remittance claims produce a deterministic reviewed allocation', () => {
  const invoices = Array.from({ length: 8 }, (_, index) => invoice({
    id: `rem_${index + 1}`, number: `REM-${index + 1}`, customerId: 'many', customerName: 'Many Corp',
    totalAmountCents: 1000, remainingAmountCents: 1000
  }));
  const remittanceClaims = invoices.map((item, index) => ({
    invoiceNumber: item.number, amountCents: 1000, currency: 'USD',
    citation: { locator: `page 1 line ${index + 1}`, textHash: 'a'.repeat(64) }
  }));
  const proposal = proposeMatches(
    transfer({ amountCents: 8000, senderName: 'Unknown', reference: 'batch' }),
    invoices, [], [], { remittanceClaims }
  ).find((item) => item.kind === 'remittance');
  assert.equal(proposal.allocations.length, 8);
  assert.equal(proposal.autoEligible, false);
  assert(proposal.signals.some((item) => item.code === 'remittance_verified'));
});

test('configured settlement tolerances stay typed and require approval', () => {
  const proposal = proposeMatches(
    transfer({ amountCents: 9900, reference: 'LAG-2026-1042' }),
    [invoice({ totalAmountCents: 10000, remainingAmountCents: 10000 })], [], [],
    { customerPolicies: [{ customerId: 'cus_1', version: 3, maxBankFeeCents: 150 }] }
  ).find((item) => item.kind === 'tolerance');
  assert.deepEqual(proposal.allocations, [{ invoiceId: 'inv_1', amountCents: 9900 }]);
  assert.deepEqual(proposal.adjustments, [{ invoiceId: 'inv_1', type: 'bank_fee_writeoff', amountCents: 100, currency: 'USD', policyVersion: 3 }]);
  assert.equal(proposal.autoEligible, false);
});

test('partial payments are proposed but not auto-applied without an exact reference', () => {
  const proposals = proposeMatches(transfer({ amountCents: 45000, reference: 'PART PAYMENT' }), [invoice()]);
  assert.equal(proposals[0].allocations[0].amountCents, 45000);
  assert.equal(proposals[0].autoEligible, false);
  assert(proposals[0].signals.some((item) => item.code === 'amount_partial'));
});

test('currency mismatch is a hard blocker', () => {
  const result = scoreInvoice(transfer({ currency: 'EUR' }), invoice());
  assert(result.blockers.includes('currency_mismatch'));
  assert.equal(proposeMatches(transfer({ currency: 'EUR' }), [invoice()]).length, 0);
});

test('pending transfers are never proposed', () => {
  assert.equal(proposeMatches(transfer({ status: 'pending' }), [invoice()]).length, 0);
});

// Regression: two candidates whose signal totals both exceed the 0-100 display ceiling
// must still be separable, otherwise the margin that gates auto-eligibility is erased.
test('a saturated score still leaves a margin between an exact and a partial candidate', () => {
  const identities = [{ fingerprint: 'fp1', customerId: 'cust_a', label: 'NORTHWIND' }];
  const transfer = {
    amountCents: 880000, currency: 'USD', status: 'posted', bookedAt: '2026-08-19T14:10:00Z',
    senderName: 'NORTHWIND ROBOTICS INC', senderAccountFingerprint: 'fp1',
    reference: 'INCOMING WIRE NORTHWIND ROBOTICS'
  };
  const base = {
    customerId: 'cust_a', customerName: 'Northwind Robotics', currency: 'USD',
    paymentStatus: 'pending', issuedAt: '2026-08-01'
  };
  const exact = { ...base, id: 'inv_exact', number: 'ACM-1-002', totalAmountCents: 880000, remainingAmountCents: 880000 };
  const partial = { ...base, id: 'inv_partial', number: 'ACM-1-001', totalAmountCents: 1250000, remainingAmountCents: 1250000 };

  const exactScored = scoreInvoice(transfer, exact, identities);
  const partialScored = scoreInvoice(transfer, partial, identities);
  assert.equal(exactScored.score, 100);
  assert.equal(partialScored.score, 100, 'both clamp to the display ceiling');
  assert(exactScored.rawScore > partialScored.rawScore, 'unclamped totals must still differ');

  const proposals = proposeMatches(transfer, [partial, exact], identities);
  assert.equal(proposals[0].allocations[0].invoiceId, 'inv_exact', 'exact amount must rank first');
  assert(proposals[0].margin > 0, 'margin must survive saturation');
});
