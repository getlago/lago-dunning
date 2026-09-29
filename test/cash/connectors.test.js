import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { LagoConnector, normalizeLagoInvoice } from '../../src/cash/connectors/lago.js';
import { MercuryConnector, normalizeMercuryTransaction } from '../../src/cash/connectors/mercury.js';
import { QontoConnector, normalizeQontoTransaction } from '../../src/cash/connectors/qonto.js';
import { BrexConnector, normalizeBrexCashTransaction } from '../../src/cash/connectors/brex.js';
import { RampConnector, normalizeRampTreasuryTransaction } from '../../src/cash/connectors/ramp.js';
import { parseStatementCsv } from '../../src/cash/connectors/statement-file.js';
import { verifyTimestampedHmac } from '../../src/cash/connectors/signatures.js';

test('normalizes an incoming posted Mercury transaction', () => {
  const result = normalizeMercuryTransaction({
    id: 'm1', accountId: 'a1', amount: 123.45, currency: 'USD', status: 'sent', postedAt: '2026-08-10T12:00:00Z',
    counterparty: { name: 'Acme Inc', accountNumber: '1234' }, externalMemo: 'LAG-1'
  });
  assert.equal(result.amountCents, 12345);
  assert.equal(result.direction, 'credit');
  assert.equal(result.status, 'posted');
  assert(result.senderAccountFingerprint);
});

test('normalizes a completed Qonto credit with transfer identity', () => {
  const result = normalizeQontoTransaction({
    id: 'q1', amount_cents: 4321, currency: 'EUR', side: 'credit', status: 'completed', settled_at: '2026-08-10T12:00:00Z',
    label: 'Acme', reference: 'LAG-2', transfer: { counterparty_name: 'Acme SAS', counterparty_iban: 'FR123' }
  }, 'qa1');
  assert.equal(result.amountCents, 4321);
  assert.equal(result.direction, 'credit');
  assert.equal(result.senderName, 'Acme SAS');
  assert(result.senderAccountFingerprint);
});

test('normalizes a settled incoming Brex cash transaction', () => {
  const result = normalizeBrexCashTransaction({
    id: 'b1', status: 'SETTLED', direction: 'CREDIT', amount: { amount: 125000, currency: 'USD' },
    posted_at: '2026-08-10T12:00:00Z', description: 'ACME INC', memo: 'LAG-3',
    counterparty: { name: 'Acme Inc', account_number: '9876' }
  }, 'cash1');
  assert.equal(result.provider, 'brex');
  assert.equal(result.amountCents, 125000);
  assert.equal(result.direction, 'credit');
  assert.equal(result.reference, 'LAG-3');
});

test('normalizes Ramp Treasury credit amounts in minor units', () => {
  const result = normalizeRampTreasuryTransaction({
    id: 'r1', status: 'COMPLETED', direction: 'INCOMING',
    amount: { amount: 72500, currency_code: 'USD', minor_unit_conversion_rate: 100 },
    settled_at: '2026-08-10T12:00:00Z', counterparty: { name: 'Orbit' }, reference_number: 'LAG-4'
  }, 'treasury1');
  assert.equal(result.provider, 'ramp');
  assert.equal(result.amountCents, 72500);
  assert.equal(result.direction, 'credit');
});

test('normalizes Lago remaining balance and customer', () => {
  const result = normalizeLagoInvoice({
    lago_id: 'i1', number: 'LAG-1', lago_customer_id: 'c1', total_amount_cents: 10000,
    total_paid_amount_cents: 2500, total_due_amount_cents: 7500, currency: 'USD', payment_status: 'pending', issuing_date: '2026-08-01',
    customer: { name: 'Acme', external_salesforce_id: '001SF' }
  });
  assert.equal(result.remainingAmountCents, 7500);
  assert.equal(result.customerName, 'Acme');
  assert.equal(result.customerExternalSalesforceId, '001SF');
});

test('Mercury and Qonto accept their documented timestamped webhook signature shape', () => {
  const body = '{"id":"evt_1"}';
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = 'test-secret';
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(verifyTimestampedHmac(body, header, secret, timestamp), true);
  assert.equal(verifyTimestampedHmac(body, header, secret, timestamp + 301), false);
  assert.equal(verifyTimestampedHmac(`${body} `, header, secret, timestamp), false);
  assert.equal(new MercuryConnector({ webhookSecret: secret }).verifyWebhook(body, header), true);
  assert.equal(new QontoConnector({ webhookSecret: secret }).verifyWebhook(body, header), true);
});

test('Mercury polling requests organization transactions and keeps settled credits', async () => {
  let requested;
  const connector = new MercuryConnector({ baseUrl: 'https://mercury.test/api/v1', token: 'token' }, async (url, options) => {
    requested = { url: String(url), options };
    return { transactions: [
      { id: 'credit', accountId: 'a1', amount: 10, currency: 'USD', status: 'sent', postedAt: '2026-08-01' },
      { id: 'debit', accountId: 'a1', amount: -5, currency: 'USD', status: 'sent', postedAt: '2026-08-01' }
    ] };
  });
  const rows = await connector.listIncoming({ postedStart: '2026-08-01' });
  assert.equal(rows.length, 1);
  assert.match(requested.url, /postedStart=2026-08-01/);
  assert.equal(requested.options.headers.authorization, 'Bearer token');
});

test('Mercury polling advances start_after across full pages', async () => {
  const urls = [];
  const first = Array.from({ length: 1000 }, (_, index) => ({
    id: `m${index}`, accountId: 'a1', amount: 1, currency: 'USD', status: 'sent', postedAt: '2026-08-01'
  }));
  const connector = new MercuryConnector({ baseUrl: 'https://mercury.test/api/v1', token: 'token' }, async (url) => {
    urls.push(String(url));
    return new URL(url).searchParams.has('start_after')
      ? { transactions: [{ id: 'last', accountId: 'a1', amount: 1, currency: 'USD', status: 'sent', postedAt: '2026-08-01' }] }
      : { transactions: first };
  });
  const rows = await connector.listIncoming();
  assert.equal(rows.length, 1001);
  assert.equal(new URL(urls[1]).searchParams.get('start_after'), 'm999');
});

test('Qonto polling follows pagination and requests completed credits only', async () => {
  const urls = [];
  const connector = new QontoConnector({ baseUrl: 'https://qonto.test/v2', token: 'token', bankAccountIds: ['bank1'] }, async (url) => {
    urls.push(String(url));
    const page = new URL(url).searchParams.get('page');
    return { transactions: [{ id: `q${page}`, amount_cents: 100, currency: 'EUR', side: 'credit', status: 'completed', settled_at: '2026-08-01' }], meta: { next_page: page === '1' ? 2 : null } };
  });
  const rows = await connector.listIncoming();
  assert.equal(rows.length, 2);
  assert.equal(urls.length, 2);
  assert(urls[0].includes('side=credit'));
  assert(urls[0].includes('status%5B%5D=completed'));
  assert(urls[1].includes('page=2'));
});

test('Brex discovers cash accounts, paginates, and keeps settled credits', async () => {
  const urls = [];
  const connector = new BrexConnector({ baseUrl: 'https://brex.test', token: 'token', cashAccountIds: [] }, async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/v2/accounts/cash')) return { items: [{ id: 'cash1', status: 'ACTIVE' }] };
    const cursor = new URL(url).searchParams.get('cursor');
    return cursor
      ? { items: [], next_cursor: null }
      : { items: [{ id: 'b1', status: 'SETTLED', direction: 'CREDIT', amount: { amount: 100, currency: 'USD' }, posted_at: '2026-08-01' }], next_cursor: 'next' };
  });
  const rows = await connector.listIncoming();
  assert.equal(rows.length, 1);
  assert.equal(urls.length, 3);
  assert.match(urls[1], /\/v2\/transactions\/cash\/cash1/);
});

test('Ramp Treasury polling follows opaque page cursors', async () => {
  const urls = [];
  const connector = new RampConnector({ baseUrl: 'https://ramp.test/developer/v1', token: 'token', receiptsPath: '/treasury/transactions', accountId: 't1' }, async (url) => {
    urls.push(String(url));
    const cursor = new URL(url).searchParams.get('start');
    return cursor
      ? { data: [], page: { next: null } }
      : { data: [{ id: 'r1', status: 'POSTED', direction: 'CREDIT', amount: { amount: 100, currency_code: 'USD', minor_unit_conversion_rate: 100 }, posted_at: '2026-08-01' }], page: { next: 'opaque' } };
  });
  const rows = await connector.listIncoming();
  assert.equal(rows.length, 1);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /start=opaque/);
});

test('Lago sync takes the remaining invoice balance from total_due_amount_cents', async () => {
  const connector = new LagoConnector({ baseUrl: 'https://lago.test/api/v1', apiKey: 'key' }, async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/invoices')) return { invoices: [{ lago_id: 'i1', number: 'LAG-1', lago_customer_id: 'c1', total_amount_cents: 10000, total_paid_amount_cents: 2500, total_due_amount_cents: 7500, currency: 'USD', payment_status: 'pending', issuing_date: '2026-08-01', customer: { name: 'Acme' } }], meta: {} };
    if (parsed.pathname.endsWith('/payments')) return { payments: [{ amount_cents: 2500, payment_status: 'succeeded' }, { amount_cents: 1000, payment_status: 'failed' }] };
    throw new Error(`Unexpected URL: ${url}`);
  });
  const invoices = await connector.listOpenInvoices();
  assert.equal(invoices[0].remainingAmountCents, 7500);
});

test('Lago payment creation uses the official manual payment payload', async () => {
  let captured;
  const connector = new LagoConnector({ baseUrl: 'https://lago.test/api/v1', apiKey: 'key' }, async (url, options) => {
    captured = { url, options };
    return { payment: { lago_id: 'p1' } };
  });
  await connector.createPayment({ invoiceId: 'i1', amountCents: 1234, reference: 'mercury:a:t', paidAt: '2026-08-10T12:00:00Z' });
  assert.equal(captured.options.method, 'POST');
  assert.deepEqual(JSON.parse(captured.options.body), { payment: { invoice_id: 'i1', amount_cents: 1234, reference: 'mercury:a:t', paid_at: '2026-08-10' } });
});

test('Lago payment lookup searches every page before creating a duplicate', async () => {
  const urls = [];
  const connector = new LagoConnector({ baseUrl: 'https://lago.test/api/v1', apiKey: 'key' }, async (url) => {
    urls.push(String(url));
    const page = new URL(url).searchParams.get('page');
    return page === '1'
      ? { payments: [{ lago_id: 'p1', reference: 'other' }], meta: { next_page: 2 } }
      : { payments: [{ lago_id: 'p2', reference: 'target' }], meta: {} };
  });
  assert.equal((await connector.findPaymentByReference('inv1', 'target')).lago_id, 'p2');
  assert.equal(urls.length, 2);
});

test('statement CSV import supports quoted fields and explicit account identity', () => {
  const rows = parseStatementCsv(
    'id,status,direction,amount,currency,booked_at,sender_name,sender_account,reference\n' +
    'wire-1,posted,credit,123.45,USD,2026-08-10,"Acme, Inc.",US123,LAG-1\n',
    { accountId: 'bank-account-1' }
  );
  assert.equal(rows[0].amountCents, 12345);
  assert.equal(rows[0].senderName, 'Acme, Inc.');
  assert.equal(rows[0].accountId, 'bank-account-1');
  assert.throws(() => parseStatementCsv(
    'id,amount,currency,booked_at\nwire-1,1,USD,2026-08-10\nwire-1,2,USD,2026-08-11\n',
    { accountId: 'bank-account-1' }
  ), /duplicate source ID/);
  assert.throws(() => parseStatementCsv(
    'id,amount,currency,booked_at\nwire-1,1,USD,2026-08-10\n',
    { sourceSystem: 'mercury', accountId: 'bank-account-1' }
  ), /cannot impersonate a live provider/);
});

test('statement CSV refuses comma-decimal amounts instead of mis-scaling them', () => {
  const csv = (amount) => `id,amount,currency,booked_at\nwire-1,${amount},EUR,2026-08-10\n`;
  const cents = (amount, options = {}) => parseStatementCsv(csv(amount), { accountId: 'bank-account-1', ...options })[0].amountCents;
  assert.equal(cents('"1,234.56"'), 123456);
  assert.equal(cents('1234.56'), 123456);
  assert.equal(cents('100.00'), 10000);
  assert.equal(cents('-50.25'), 5025);
  assert.equal(cents('12345', { amountUnit: 'minor' }), 12345);
  for (const amount of ['"1234,56"', '"1.234,56"', '"12,34"', '1e5', '12 EUR']) {
    assert.throws(() => parseStatementCsv(csv(amount), { accountId: 'bank-account-1' }), /Row 2 has an amount we can't read safely: .*Use a dot for decimals/i);
  }
});

// Shape per docs.mercury.com: flat counterpartyName, no counterparty object, no
// currency or direction field, counterparty account number only inside details.
// The nested shape above is kept for backward compatibility, but Mercury sends this one.
test('normalizes an incoming posted Mercury transaction in the documented shape', () => {
  const result = normalizeMercuryTransaction({
    id: 'm1', accountId: 'a1', amount: 123.45, status: 'sent', postedAt: '2026-08-10T12:00:00Z',
    counterpartyId: 'cp1', counterpartyName: 'Acme Inc', counterpartyNickname: null,
    externalMemo: 'LAG-1', bankDescription: 'INCOMING WIRE ACME', note: null,
    kind: 'incomingDomesticWire',
    details: { electronicRoutingInfo: { accountNumber: '1234', routingNumber: '021000021' } }
  });
  assert.equal(result.amountCents, 12345);
  assert.equal(result.currency, 'USD');
  assert.equal(result.direction, 'credit');
  assert.equal(result.status, 'posted');
  assert.equal(result.senderName, 'Acme Inc');
  assert.equal(result.reference, 'LAG-1');
  assert(result.senderAccountFingerprint, 'account number must be read out of details.*RoutingInfo');
});

test('a Mercury wire still fingerprints when routing info arrives as a domestic wire', () => {
  const result = normalizeMercuryTransaction({
    id: 'm2', accountId: 'a1', amount: 50, status: 'sent', postedAt: '2026-08-10T12:00:00Z',
    counterpartyName: 'Beta LLC',
    details: { domesticWireRoutingInfo: { accountNumber: '9999' } }
  });
  assert(result.senderAccountFingerprint);
});

test('two Mercury senders fingerprint differently by account number', () => {
  const one = normalizeMercuryTransaction({ id: 'm3', amount: 10, status: 'sent', postedAt: '2026-08-10',
    counterpartyName: 'A', details: { electronicRoutingInfo: { accountNumber: '1111' } } });
  const two = normalizeMercuryTransaction({ id: 'm4', amount: 10, status: 'sent', postedAt: '2026-08-10',
    counterpartyName: 'B', details: { electronicRoutingInfo: { accountNumber: '2222' } } });
  assert.notEqual(one.senderAccountFingerprint, two.senderAccountFingerprint);
});

test('a Mercury transaction with no routing info yields no fingerprint rather than a shared one', () => {
  const a = normalizeMercuryTransaction({ id: 'm5', amount: 10, status: 'sent', postedAt: '2026-08-10', counterpartyName: 'A' });
  const b = normalizeMercuryTransaction({ id: 'm6', amount: 20, status: 'sent', postedAt: '2026-08-10', counterpartyName: 'B' });
  assert.equal(a.senderAccountFingerprint, null);
  assert.equal(b.senderAccountFingerprint, null);
});

test('Qonto sends the staging token only when one is configured, on every request', async () => {
  const seen = [];
  const make = (config) => new QontoConnector(config, async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    return String(url).includes('/bank_accounts')
      ? { bank_accounts: [{ id: 'acc1', status: 'active' }], meta: {} }
      : { transactions: [], meta: {} };
  });

  await make({ baseUrl: 'https://qonto.test/v2', token: 'tok', bankAccountIds: [] }).listIncoming();
  assert(seen.every((call) => call.headers['x-qonto-staging-token'] === undefined),
    'production must not send the header on any request');

  seen.length = 0;
  await make({ baseUrl: 'https://sandbox.qonto.test/v2', token: 'tok', bankAccountIds: [], stagingToken: 'stg_1' }).listIncoming();
  // Qonto requires the staging header on every Sandbox request, discovery included.
  assert.equal(seen.length, 2);
  assert(seen.every((call) => call.headers['x-qonto-staging-token'] === 'stg_1'),
    'sandbox requires the header on bank_accounts and transactions alike');
  assert(seen.every((call) => call.headers.authorization === 'Bearer tok'));
});

// Payloads below are trimmed from real responses of the Qonto Sandbox
// (thirdparty-sandbox.staging.qonto.co), not from this parser.
test('a real Qonto credit reads its payer from the income block, not from transfer', () => {
  const result = normalizeQontoTransaction({
    id: '01a01b90-75c9-72a6-9d7b-a331987ac012',
    bank_account_id: '01a01b90-5906-7976-bdc1-bbccad7289bc',
    side: 'credit', status: 'completed', operation_type: 'income', subject_type: 'Income',
    amount: 5000.0, amount_cents: 500000, currency: 'EUR',
    settled_at: '2026-08-19T19:47:27.232Z', emitted_at: '2026-08-19T19:47:27.100Z',
    label: 'Sandbox income 1', note: null, reference: 'POP SVCS, DOB 19800714',
    clean_counterparty_name: null,
    income: {
      counterparty_account_number: 'DE45640901000478824009',
      counterparty_account_number_format: 'IBAN',
      counterparty_bank_identifier: 'VBRTDE6R',
      counterparty_bank_identifier_format: 'SWIFT_BIC'
    }
  });
  assert.equal(result.amountCents, 500000);
  assert.equal(result.currency, 'EUR');
  assert.equal(result.status, 'posted');
  assert.equal(result.direction, 'credit');
  assert.equal(result.bookedAt, '2026-08-19T19:47:27.232Z');
  assert.equal(result.senderBank, 'VBRTDE6R');
  assert(result.senderAccountFingerprint, 'the IBAN in `income` must produce a fingerprint');
});

// Verified against a real SCT IN transaction created in the Qonto Sandbox: for a genuine
// incoming SEPA credit the debtor name arrives in `label`, not in a counterparty field.
test('a real Qonto SEPA credit takes the payer name from label when nothing better exists', () => {
  const result = normalizeQontoTransaction({
    id: '01a01b90-9f00-7000-0000-000000000001', bank_account_id: 'a1',
    side: 'credit', status: 'completed', operation_type: 'income', subject_type: 'Income',
    amount_cents: 500000, currency: 'EUR', settled_at: '2026-08-19T21:39:37.143Z',
    label: 'RIVAGE ANALYTICS SAS', reference: 'Payment ACM-2245-013-001',
    clean_counterparty_name: null,
    income: {
      counterparty_account_number: 'FR2730004000010000123456701',
      counterparty_bank_identifier: 'BNPAFRPPXXX'
    }
  });
  assert.equal(result.senderName, 'RIVAGE ANALYTICS SAS');
  assert.equal(result.senderBank, 'BNPAFRPPXXX');
  assert.equal(result.reference, 'Payment ACM-2245-013-001');
  assert(result.senderAccountFingerprint);
});

test('a Qonto credit prefers clean_counterparty_name when Qonto resolves it', () => {
  const result = normalizeQontoTransaction({
    id: 't2', bank_account_id: 'a1', side: 'credit', status: 'completed',
    amount_cents: 1000, currency: 'EUR', settled_at: '2026-08-19T00:00:00Z',
    label: 'TOPUP', clean_counterparty_name: 'NORTHWIND ROBOTICS SAS',
    income: { counterparty_account_number: 'DE456409010004788240' }
  });
  assert.equal(result.senderName, 'NORTHWIND ROBOTICS SAS');
});

test('an outgoing Qonto transfer still reads the transfer block', () => {
  const result = normalizeQontoTransaction({
    id: 't3', bank_account_id: 'a1', side: 'debit', status: 'completed',
    amount_cents: 2000, currency: 'EUR', settled_at: '2026-08-19T00:00:00Z',
    label: 'Supplier payment',
    transfer: { counterparty_name: 'Supplier SA', counterparty_account_number: 'FR761695800001' }
  });
  assert.equal(result.senderName, 'Supplier SA');
  assert.equal(result.direction, 'debit');
  assert(result.senderAccountFingerprint);
});

test('Qonto discovers active bank accounts when none are configured', async () => {
  const urls = [];
  const connector = new QontoConnector({
    baseUrl: 'https://qonto.test/v2', token: 'tok', bankAccountIds: [], stagingToken: 'stg'
  }, async (url) => {
    urls.push(String(url));
    if (String(url).includes('/bank_accounts')) {
      return { bank_accounts: [
        { id: 'acc-active', status: 'active' },
        { id: 'acc-closed', status: 'closed' }
      ], meta: {} };
    }
    return { transactions: [], meta: {} };
  });
  await connector.listIncoming();
  assert.match(urls[0], /\/bank_accounts/);
  // /v2/transactions rejects a request without bank_account_id, so it must always be sent.
  assert.match(urls[1], /bank_account_id=acc-active/);
  assert.equal(urls.length, 2, 'a closed account must not be polled');
});

test('Qonto fails loudly when no readable bank account exists', async () => {
  const connector = new QontoConnector({
    baseUrl: 'https://qonto.test/v2', token: 'tok', bankAccountIds: []
  }, async () => ({ bank_accounts: [], meta: {} }));
  await assert.rejects(() => connector.listIncoming(), /No active Qonto bank account is readable/);
});
