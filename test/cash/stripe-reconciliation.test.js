import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeStripeCashTransaction, normalizeStripePaymentIntent, StripeConnector } from '../../src/cash/connectors/stripe.js';
import { ReconciliationStore } from '../../src/cash/db.js';
import { ReconciliationService } from '../../src/cash/service.js';
import { detectStripeIncidents } from '../../src/cash/stripe-reconciler.js';

const invoice1 = { id: 'inv1', number: 'LAG-001', customerId: 'lago-cus', customerName: 'Acme', currency: 'USD',
  totalAmountCents: 10000, paymentStatus: 'succeeded', remainingAmountCents: 0, issuedAt: '2026-01-01' };
const invoice2 = { ...invoice1, id: 'inv2', number: 'LAG-002', totalAmountCents: 8000 };

// Shape per Stripe's API reference: payer details sit under a key named by
// bank_transfer.type, never on bank_transfer itself.
test('normalizes a Stripe EU bank transfer with type-nested payer details', () => {
  const cash = normalizeStripeCashTransaction({
    id: 'ccsbtxn_1', object: 'customer_cash_balance_transaction', type: 'funded',
    net_amount: 10000, currency: 'eur', created: 1690829143, ending_balance: 10000,
    funded: { bank_transfer: {
      eu_bank_transfer: { bic: 'BANKDEAAXXX', iban_last4: '7089', sender_name: 'Sample Business GmbH' },
      reference: 'Payment for Invoice 28278FC-155', type: 'eu_bank_transfer'
    } }
  }, 'cus_stripe');
  assert.equal(cash.reference, 'Payment for Invoice 28278FC-155');
  assert.equal(cash.senderName, 'Sample Business GmbH');
  assert.equal(cash.senderBank, 'BANKDEAAXXX');
});

test('a Stripe US bank transfer with a blank sender name yields null, not an empty string', () => {
  const cash = normalizeStripeCashTransaction({
    id: 'ccsbtxn_2', type: 'funded', net_amount: 1400000, currency: 'usd', created: 1690829143,
    funded: { bank_transfer: {
      reference: 'ACM-2245-009-001', type: 'us_bank_transfer',
      us_bank_transfer: { network: 'ach', sender_name: '' }
    } }
  }, 'cus_stripe');
  assert.equal(cash.reference, 'ACM-2245-009-001');
  assert.equal(cash.senderName, null);
});

test('normalizes Stripe cash-balance and PaymentIntent evidence', () => {
  const cash = normalizeStripeCashTransaction({ id: 'ccsb1', type: 'funded', net_amount: 10000, currency: 'usd', created: 10,
    funded: { bank_transfer: { reference: 'LAG-001', sender_name: 'Acme' } } }, 'cus_stripe');
  const intent = normalizeStripePaymentIntent({ id: 'pi1', customer: 'cus_stripe', status: 'succeeded', amount: 8000,
    amount_received: 8000, currency: 'usd', created: 20, metadata: { lago_invoice_id: 'inv2', lago_invoice_number: 'LAG-002' } });
  assert.equal(cash.reference, 'LAG-001');
  assert.equal(intent.invoiceId, 'inv2');
  assert.equal(intent.settledAt, '1970-01-01T00:00:20.000Z');
  assert.equal(intent.canceledAt, null);
});

test('stranded-cash sequence raises manual-settlement, wrong-allocation, and old-cash incidents', () => {
  const incidents = detectStripeIncidents({ customerId: 'cus_stripe', lagoCustomerId: 'lago-cus', invoices: [invoice1, invoice2],
    payments: [{ id: 'manual1', invoiceId: 'inv1', status: 'succeeded', providerPaymentId: null }],
    paymentIntents: [
      { id: 'pi1', customerId: 'cus_stripe', status: 'canceled', amountCents: 10000, amountReceivedCents: 0, createdAt: '2026-01-01T00:00:00Z', invoiceId: 'inv1', invoiceNumber: 'LAG-001' },
      { id: 'pi2', customerId: 'cus_stripe', status: 'succeeded', amountCents: 8000, amountReceivedCents: 8000, createdAt: '2026-01-03T00:00:00Z', invoiceId: 'inv2', invoiceNumber: 'LAG-002' }
    ],
    cashTransactions: [
      { id: 'fund1', customerId: 'cus_stripe', type: 'funded', amountCents: 10000, createdAt: '2026-01-02T00:00:00Z', reference: 'LAG-001' },
      { id: 'apply1', customerId: 'cus_stripe', type: 'applied_to_payment', amountCents: -8000, createdAt: '2026-01-03T00:01:00Z', paymentIntentId: 'pi2' }
    ] });
  const kinds = incidents.map((item) => item.kind);
  assert(kinds.includes('lago_manual_payment_without_stripe_settlement'));
  assert(kinds.includes('stripe_allocation_reference_mismatch'));
  assert(kinds.includes('stripe_old_cash_auto_applied'));
  assert(kinds.includes('stripe_unallocated_cash_balance'));
});

test('Stripe connector paginates both ledgers', async () => {
  const urls = [];
  const connector = new StripeConnector({ baseUrl: 'https://stripe.test/v1', apiKey: 'sk_test' }, async (url) => {
    urls.push(String(url));
    const second = new URL(url).searchParams.has('starting_after');
    return { data: second ? [] : [{ id: 'tx1', type: 'funded', net_amount: 100, currency: 'usd', created: 1 }], has_more: !second };
  });
  const rows = await connector.listCashBalanceTransactions('cus_1');
  assert.equal(rows.length, 1);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /starting_after=tx1/);
});

test('Stripe sync persists and refreshes incidents without duplicating them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-stripe-'));
  const store = new ReconciliationStore(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  store.upsertInvoice(invoice1);
  store.upsertLagoPayment({ id: 'manual1', invoiceId: 'inv1', status: 'succeeded', amountCents: 10000,
    providerPaymentId: null, providerCode: null, reference: 'manual', paidAt: '2026-01-02', raw: {} });
  const stripe = {
    listCashBalanceTransactions: async () => [{ id: 'fund1', customerId: 'cus_stripe', type: 'funded', amountCents: 10000,
      currency: 'USD', createdAt: '2026-01-02T00:00:00Z', reference: 'LAG-001' }],
    listPaymentIntents: async () => [{ id: 'pi1', customerId: 'cus_stripe', status: 'canceled', amountCents: 10000,
      amountReceivedCents: 0, currency: 'USD', createdAt: '2026-01-01T00:00:00Z', invoiceId: 'inv1', invoiceNumber: 'LAG-001' }]
  };
  const service = new ReconciliationService({ store, stripe, stripeCustomerMap: { cus_stripe: 'lago-cus' }, lago: {}, mercury: {}, qonto: {} });
  const first = await service.syncStripe();
  const firstIds = store.listIncidents('open').map((row) => row.id).sort();
  await service.syncStripe();
  const secondIds = store.listIncidents('open').map((row) => row.id).sort();
  assert(first.incidentCount >= 2);
  assert.deepEqual(secondIds, firstIds);
  const receipt = store.getReceipt('stripe:cus_stripe:fund1');
  assert.equal(receipt.sourceSystem, 'stripe_cash_balance');
  assert.equal(receipt.grossAmountCents, 10000);
  assert.equal(receipt.unappliedAmountCents, 10000);
});
