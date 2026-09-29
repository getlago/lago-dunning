import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrexCashTransaction } from '../../src/cash/connectors/brex.js';
import { normalizeRampTreasuryTransaction } from '../../src/cash/connectors/ramp.js';
import { proposeMatches } from '../../src/cash/matcher.js';
import { detectStripeIncidents } from '../../src/cash/stripe-reconciler.js';

const invoice = (id, number, amountCents, overrides = {}) => ({
  id, number, customerId: 'customer', customerName: 'Customer Treasury', currency: 'USD',
  totalAmountCents: amountCents, remainingAmountCents: amountCents,
  paymentStatus: 'pending', issuedAt: '2026-06-01', ...overrides
});

const stripeInput = (overrides = {}) => ({
  customerId: 'cus_stripe', lagoCustomerId: 'customer', invoices: [], payments: [],
  cashTransactions: [], paymentIntents: [], ...overrides
});

test('reused wire instructions leave visible unapplied Stripe cash and a missing-intent incident', () => {
  const open = invoice('reused-current', 'REUSED-042', 12000);
  const incidents = detectStripeIncidents(stripeInput({
    invoices: [open],
    cashTransactions: [{ id: 'fund-old-iban', customerId: 'cus_stripe', type: 'funded', amountCents: 12000,
      createdAt: '2026-06-10T00:00:00Z', reference: 'OLD-WIRE-INSTRUCTIONS' }]
  }));
  assert(incidents.some((item) => item.kind === 'stripe_unallocated_cash_balance'));
  assert(incidents.some((item) => item.kind === 'lago_invoice_missing_stripe_intent' && item.evidence.invoiceId === open.id));
});

test('old Stripe cash applied to the wrong invoice is critical evidence, never a trusted paid state', () => {
  const intended = invoice('stranded-020', 'STRAND-020', 10000);
  const wrong = invoice('stranded-021', 'STRAND-021', 8000, { paymentStatus: 'succeeded', remainingAmountCents: 0 });
  const incidents = detectStripeIncidents(stripeInput({
    invoices: [intended, wrong],
    paymentIntents: [{ id: 'pi-021', customerId: 'cus_stripe', status: 'succeeded', amountCents: 8000,
      amountReceivedCents: 8000, createdAt: '2026-06-12T00:00:00Z', invoiceId: wrong.id, invoiceNumber: wrong.number }],
    cashTransactions: [
      { id: 'fund-020', customerId: 'cus_stripe', type: 'funded', amountCents: 10000,
        createdAt: '2026-06-10T00:00:00Z', reference: intended.number },
      { id: 'apply-021', customerId: 'cus_stripe', type: 'applied_to_payment', amountCents: -8000,
        createdAt: '2026-06-12T00:01:00Z', paymentIntentId: 'pi-021' }
    ]
  }));
  assert(incidents.some((item) => item.kind === 'stripe_allocation_reference_mismatch' && item.severity === 'critical'));
  assert(incidents.some((item) => item.kind === 'stripe_old_cash_auto_applied'));
});

test('a Lago-paid invoice without a Stripe settlement is flagged as divergent', () => {
  const paid = invoice('duck-056', 'STRAND-056', 2454813, { paymentStatus: 'succeeded', remainingAmountCents: 0 });
  const incidents = detectStripeIncidents(stripeInput({
    invoices: [paid],
    payments: [{ id: 'manual-056', invoiceId: paid.id, status: 'succeeded', providerPaymentId: null }]
  }));
  assert(incidents.some((item) => item.kind === 'lago_manual_payment_without_stripe_settlement'));
});

test('a Brex receipt is authoritative while the payer-side Ramp transfer is only remittance evidence', () => {
  const target = invoice('brexpayer', 'BRX-1001', 42000);
  const ramp = normalizeRampTreasuryTransaction({ id: 'ramp-out', status: 'COMPLETED', direction: 'OUTGOING',
    amount: { amount: 42000, currency_code: 'USD' }, created_at: '2026-04-01', memo: 'BRX-1001' }, 'payer');
  const brex = normalizeBrexCashTransaction({ id: 'brex-in', status: 'SETTLED', direction: 'CREDIT',
    amount: { amount: 42000, currency: 'USD' }, posted_at: '2026-04-02', reference_number: 'BRX-1001',
    counterparty: { name: 'Customer via Ramp' } }, 'brexpayer-brex');
  assert.equal(ramp.direction, 'debit');
  assert.equal(brex.direction, 'credit');
  const proposal = proposeMatches(brex, [target])[0];
  assert.equal(proposal.autoEligible, true);
  assert.equal(proposal.invoiceIds[0], target.id);
});

test('one receipt covering several invoices stays a reviewed split with conserved value', () => {
  const invoices = [invoice('split-a', 'SPLIT-101', 30000), invoice('split-b', 'SPLIT-102', 42500)];
  const transfer = { provider: 'brex', accountId: 'split', providerTransactionId: 'split-wire', status: 'posted',
    direction: 'credit', amountCents: 72500, currency: 'USD', bookedAt: '2026-06-10',
    senderName: 'Customer Treasury', reference: 'June invoices' };
  const split = proposeMatches(transfer, invoices).find((item) => item.kind === 'split');
  assert(split);
  assert.equal(split.autoEligible, false);
  assert.equal(split.allocations.reduce((sum, item) => sum + item.amountCents, 0), transfer.amountCents);
});

test('missing invoice references create a review case rather than an automatic allocation', () => {
  const target = invoice('northwind-ref', 'NW-25805', 49000, { customerName: 'Northwind Robotics' });
  const transfer = { provider: 'stripe_cash_balance', accountId: 'cus_noref', providerTransactionId: 'cash-1',
    status: 'posted', direction: 'credit', amountCents: 49000, currency: 'USD', bookedAt: '2026-08-01',
    senderName: 'Northwind Robotics', reference: 'Overdue invoices' };
  const proposal = proposeMatches(transfer, [target])[0];
  assert(proposal);
  assert.equal(proposal.autoEligible, false);
  assert.notEqual(proposal.confidence, 'automatic');
});

test('a late cancellation after a successful intent raises a regression incident', () => {
  const paidButOverdue = invoice('noref-overdue', 'NR-PAID', 15000, { paymentStatus: 'failed' });
  const incidents = detectStripeIncidents(stripeInput({
    invoices: [paidButOverdue],
    paymentIntents: [
      { id: 'pi-success', customerId: 'cus_stripe', status: 'succeeded', amountCents: 15000,
        amountReceivedCents: 15000, createdAt: '2026-05-26T13:00:00Z', settledAt: '2026-05-26T13:17:00Z',
        invoiceId: paidButOverdue.id, invoiceNumber: paidButOverdue.number },
      { id: 'pi-old-canceled-late', customerId: 'cus_stripe', status: 'canceled', amountCents: 15000,
        amountReceivedCents: 0, createdAt: '2026-05-25T00:54:00Z', canceledAt: '2026-05-27T01:13:00Z',
        invoiceId: paidButOverdue.id, invoiceNumber: paidButOverdue.number }
    ]
  }));
  assert(incidents.some((item) => item.kind === 'stripe_settled_lago_unpaid'));
  assert(incidents.some((item) => item.kind === 'late_stripe_failure_after_settlement' && item.severity === 'critical'));
});
