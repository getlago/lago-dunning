import assert from 'node:assert/strict';
import test from 'node:test';
import { SalesforceConnector, normalizeSalesforceAccount } from '../../src/cash/connectors/salesforce.js';
import { proposeMatches } from '../../src/cash/matcher.js';

const invoice = {
  id: 'inv1', number: 'LAG-1', customerId: 'cus1', customerName: 'Acme France', currency: 'USD',
  totalAmountCents: 10000, remainingAmountCents: 10000, paymentStatus: 'pending', issuedAt: '2026-08-01'
};
const transfer = {
  provider: 'mercury', accountId: 'bank1', providerTransactionId: 'txn1', status: 'posted', direction: 'credit',
  amountCents: 10000, currency: 'USD', bookedAt: '2026-08-10', senderName: 'Acme Holdings', reference: 'August services'
};
const context = {
  source: 'salesforce', crmAccountId: '001', lagoCustomerId: 'cus1', accountName: 'Acme France',
  parentName: 'Acme Holdings', ownerId: '005', ownerName: 'Account Owner', aliases: ['Acme Treasury']
};

test('Salesforce account context normalizes hierarchy, ownership, aliases, and Lago identity', () => {
  const result = normalizeSalesforceAccount({
    Id: '001', Name: 'Acme France', ParentId: 'parent', Parent: { Name: 'Acme Holdings' },
    OwnerId: '005', Owner: { Name: 'Account Owner' }, Lago_Id__c: 'cus1', Payer_Aliases__c: 'Acme Treasury; ACME BV', Terms__c: 30
  }, { lagoCustomerField: 'Lago_Id__c', aliasesField: 'Payer_Aliases__c', paymentTermsField: 'Terms__c' });
  assert.equal(result.lagoCustomerId, 'cus1');
  assert.equal(result.parentName, 'Acme Holdings');
  assert.equal(result.ownerName, 'Account Owner');
  assert.deepEqual(result.aliases, ['Acme Treasury', 'ACME BV']);
  assert.equal(result.paymentTermsDays, 30);
});

test('Salesforce connector follows REST query pagination with a read token', async () => {
  const urls = [];
  const connector = new SalesforceConnector({
    instanceUrl: 'https://lago.my.salesforce.com', token: 'read-token', apiVersion: 'v67.0',
    query: 'SELECT Id, Name FROM Account', accountMap: { '001': 'cus1' }
  }, async (url, options) => {
    urls.push({ url: String(url), options });
    return urls.length === 1
      ? { records: [{ Id: '001', Name: 'Acme' }], done: false, nextRecordsUrl: '/services/data/v67.0/query/next' }
      : { records: [{ Id: '002', Name: 'Orbit' }], done: true };
  });
  const rows = await connector.listAccountContexts();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lagoCustomerId, 'cus1');
  assert.match(urls[0].url, /query\?q=SELECT/);
  assert.equal(urls[0].options.headers.authorization, 'Bearer read-token');
  assert.match(urls[1].url, /query\/next$/);
});

test('CRM parent-payer evidence improves ranking but can never authorize automatic allocation', () => {
  const withoutContext = proposeMatches(transfer, [invoice]);
  const withContext = proposeMatches(transfer, [invoice], [], [context]);
  assert(withContext[0].score > withoutContext[0].score);
  assert(withContext[0].signals.some((item) => item.code === 'crm_payer_identity'));
  assert.equal(withContext[0].autoEligible, false);
});
