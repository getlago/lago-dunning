import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NetSuiteConnector,
  SapConnector,
  normalizeBusinessCentralPayment,
  normalizeNetSuitePayment,
  normalizeQuickBooksPayment,
  normalizeSapPayment,
  normalizeXeroPayment
} from '../../src/cash/connectors/erp.js';
import { ReconciliationStore } from '../../src/cash/db.js';
import { detectErpIncidents } from '../../src/cash/erp-reconciler.js';
import { ReconciliationService } from '../../src/cash/service.js';

const invoice = { id: 'inv1', number: 'LAG-1', customerId: 'cus1', customerName: 'Acme', currency: 'USD', totalAmountCents: 10000, remainingAmountCents: 10000, paymentStatus: 'pending', issuedAt: '2026-08-01' };

test('normalizes customer payments from five ERP APIs', () => {
  const xero = normalizeXeroPayment({ PaymentID: 'x1', Status: 'AUTHORISED', Amount: 100, Reference: 'bank', Date: '2026-08-10', Invoice: { InvoiceID: 'inv1', InvoiceNumber: 'LAG-1', CurrencyCode: 'USD', Contact: { ContactID: 'c1', Name: 'Acme' } } }, 'tenant');
  const quickbooks = normalizeQuickBooksPayment({ Id: 'q1', TotalAmt: 100, UnappliedAmt: 0, TxnDate: '2026-08-10', CurrencyRef: { value: 'USD' }, CustomerRef: { value: 'c1' }, Line: [{ Amount: 100, LinkedTxn: [{ TxnId: 'inv1', TxnType: 'Invoice' }] }] }, 'realm');
  const businessCentral = normalizeBusinessCentralPayment({ id: 'b1', amount: -100, currencyCode: 'USD', postingDate: '2026-08-10', appliesToInvoiceId: 'inv1', appliesToInvoiceNumber: 'LAG-1' }, 'company');
  const netsuite = normalizeNetSuitePayment({ id: 'n1', payment: 100, currency: { refName: 'USD' }, tranDate: '2026-08-10', apply: { items: [{ apply: true, amount: 100, doc: { id: 'inv1', refName: 'LAG-1' } }] } }, 'account');
  const sap = normalizeSapPayment({ CustomerPaymentUUID: 's1', PaymentAmount: 100, TransactionCurrency: 'USD', PaymentDate: '2026-08-10', CustomerPaymentItem: [{ PaymentAmount: 100, AccountingDocument: 'inv1', InvoiceNumber: 'LAG-1' }] }, 'system');
  for (const payment of [xero, quickbooks, businessCentral, netsuite, sap]) {
    assert.equal(payment.amountCents, 10000);
    assert.equal(payment.allocations[0].externalInvoiceId, 'inv1');
  }
});

test('NetSuite uses POST SuiteQL and expands each customer payment record', async () => {
  const calls = [];
  const connector = new NetSuiteConnector({
    baseUrl: 'https://netsuite.test', token: 'token', accountId: 'acct', query: 'SELECT id FROM customerPayment ORDER BY id'
  }, async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/suiteql')) return { items: [{ id: 'n1' }], hasMore: false };
    return { id: 'n1', payment: 100, currency: { refName: 'USD' }, apply: { items: [] } };
  });
  const payments = await connector.listCustomerPayments();
  assert.equal(payments.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { q: 'SELECT id FROM customerPayment ORDER BY id' });
  assert.match(calls[1].url, /expandSubResources=true/);
});

test('SAP customer-payment reader uses the configured OData resource and business user', async () => {
  let captured;
  const connector = new SapConnector({
    baseUrl: 'https://sap.test', token: 'token', systemId: 's4', apiBusinessUser: 'finance-user',
    paymentPath: '/api/ccpcustpayment/CustomerPayment'
  }, async (url, options) => {
    captured = { url, options };
    return { value: [{ CustomerPaymentUUID: 's1', PaymentAmount: 10, TransactionCurrency: 'USD' }] };
  });
  const payments = await connector.listCustomerPayments();
  assert.equal(payments.length, 1);
  assert.equal(captured.options.headers.ApiBusinessUser, 'finance-user');
  assert.match(captured.url, /ccpcustpayment\/CustomerPayment$/);
});

test('only explicit Lago integration metadata suppresses ERP payment echoes', () => {
  const external = normalizeXeroPayment({ PaymentID: 'x1', Status: 'AUTHORISED', Amount: 100, Reference: 'bank', Date: '2026-08-10', Invoice: { InvoiceID: 'inv1', InvoiceNumber: 'LAG-1', CurrencyCode: 'USD' } }, 'tenant');
  const echo = normalizeXeroPayment({ PaymentID: 'x2', Status: 'AUTHORISED', Amount: 100, Reference: 'manual payment', origin_system: 'lago', Date: '2026-08-10', Invoice: { InvoiceID: 'inv1', InvoiceNumber: 'LAG-1', CurrencyCode: 'USD' } }, 'tenant');
  const prefixedHumanReference = normalizeXeroPayment({ PaymentID: 'x3', Status: 'AUTHORISED', Amount: 100, Reference: 'lago: customer note', Date: '2026-08-10', Invoice: { InvoiceID: 'inv1', InvoiceNumber: 'LAG-1', CurrencyCode: 'USD' } }, 'tenant');
  const incidents = detectErpIncidents({ provider: 'xero', payments: [external, echo], invoices: [invoice], lagoPayments: [] });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, 'erp_payment_missing_in_lago');
  assert.equal(echo.originSystem, 'lago');
  assert.equal(prefixedHumanReference.originSystem, null);
});

test('ERP sync persists external evidence without creating a cash receipt or Lago payment', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lago-erp-'));
  const store = new ReconciliationStore(path.join(dir, 'test.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true }); });
  store.upsertInvoice(invoice);
  const payment = normalizeXeroPayment({ PaymentID: 'x1', Status: 'AUTHORISED', Amount: 100, Reference: 'bank', Date: '2026-08-10', Invoice: { InvoiceID: 'inv1', InvoiceNumber: 'LAG-1', CurrencyCode: 'USD' } }, 'tenant');
  const service = new ReconciliationService({
    store, lago: {}, mercury: {}, qonto: {}, dryRun: true,
    erps: { xero: { listCustomerPayments: async () => [payment] } }
  });
  const result = await service.syncErp('xero');
  assert.equal(result.count, 1);
  assert.equal(result.incidents, 1);
  assert.equal(store.listExternalPayments('xero').length, 1);
  assert.equal(store.listReceipts().length, 0);
});
