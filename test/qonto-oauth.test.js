import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { QontoOAuth } from '../src/qonto-oauth.js';
import { QontoConnector } from '../src/cash/connectors/qonto.js';
import { sourceHold } from '../src/dunning.js';
import { contextForModel, runForModel } from '../src/model-context.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qonto-oauth-'));
  const store = new Store(path.join(dir, 'test.db'));
  const config = loadConfig({APP_MODE: 'connected', ADMIN_KEYS: 'test-workspace-key', QONTO_CLIENT_ID: 'client',
    QONTO_CLIENT_SECRET: 'SECRET-CLIENT', QONTO_ORGANIZATION_ID: 'org-lago', QONTO_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex')});
  const calls = []; let time = Date.now(), revision = 0;
  const responses = {
    token: () => json({access_token: `SECRET-ACCESS-${++revision}`, refresh_token: `SECRET-REFRESH-${revision}`,
      token_type: 'Bearer', expires_in: 3600, scope: 'organization.read offline_access'}),
    organization: () => json({organization: {id: 'org-lago', legal_name: 'Lago SAS'}}),
    accounts: () => json({bank_accounts: [{id: 'account-1', name: 'Operating', currency: 'EUR', iban: 'PRIVATE-IBAN'},
      {id: 'account-2', name: 'Reserve', currency: 'EUR'}]}),
    transactions: () => json({transactions: [{id: 'tx-1', side: 'credit', status: 'completed', amount_cents: 20000,
      currency: 'EUR', settled_at: new Date(time).toISOString(), label: 'Acme', reference: 'INV-1'}]}),
    revoke: () => new Response(null, {status: 204})
  };
  const fetcher = async (url, options) => {
    calls.push({url: String(url), options});
    const u = new URL(url);
    if (u.pathname === '/oauth2/token') return responses.token(options);
    if (u.pathname === '/v2/organization') return responses.organization();
    if (u.pathname === '/v2/bank_accounts') return responses.accounts();
    if (u.pathname.startsWith('/v2/transactions')) return responses.transactions();
    if (u.pathname === '/v2/oauth2/consents') return responses.revoke();
    assert.fail(`Unexpected request ${u.pathname}`);
  };
  const oauth = new QontoOAuth(store, config, {fetcher, now: () => time});
  const begin = () => {
    const flow = oauth.begin('http://localhost:4320'), params = new URL(flow.url).searchParams;
    return {flow, params: new URLSearchParams({state: params.get('state'), code: 'private-code'}), binding: flow.cookie.split(';')[0].split('=')[1]};
  };
  const connect = async () => {const f = begin(); await oauth.complete(f.params, f.binding); return f;};
  t.after(() => {store.close(); fs.rmSync(dir, {recursive: true, force: true});});
  return {store, config, oauth, calls, responses, begin, connect, fetcher, advance: ms => time += ms, now: () => time};
}

test('authorization URL requests only read scopes, locks organisation and binds the browser', t => {
  const {begin, calls} = setup(t), {flow} = begin(), url = new URL(flow.url);
  assert.equal(url.origin, 'https://oauth.qonto.com');
  assert.equal(url.searchParams.get('scope'), 'organization.read offline_access');
  assert.equal(url.searchParams.get('organization_id'), 'org-lago');
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.match(flow.cookie, /HttpOnly; SameSite=Lax/);
  assert.equal(calls.length, 0); // Authorization is opened only in the user's browser.
});
test('state rejects missing browser cookie, forged state, expiry and replay', async t => {
  const {oauth, begin, advance, calls} = setup(t), f = begin();
  await assert.rejects(oauth.complete(f.params, undefined), /could not be verified/);
  await assert.rejects(oauth.complete(new URLSearchParams({state: 'forged'}), f.binding), /could not be verified/);
  assert.equal(calls.length, 0);
  await oauth.complete(f.params, f.binding);
  await assert.rejects(oauth.complete(f.params, f.binding), /could not be verified/);
  await oauth.disconnect();
  const stale = begin(); advance(600001);
  await assert.rejects(oauth.complete(stale.params, stale.binding), /expired/);
});
test('denied consent makes no token request and consumes state', async t => {
  const {oauth, begin, calls} = setup(t), f = begin(); f.params.set('error', 'access_denied');
  await assert.rejects(oauth.complete(f.params, f.binding), /not granted/);
  await assert.rejects(oauth.complete(f.params, f.binding), /verified/);
  assert.equal(calls.length, 0);
});
test('tokens are encrypted, account metadata omits IBAN, and wrong keys fail closed', async t => {
  const {oauth, connect, store, config, calls} = setup(t); await connect();
  const ciphertext = store.db.prepare('SELECT ciphertext FROM qonto_oauth').get().ciphertext;
  assert(!ciphertext.includes('SECRET-')); assert(!JSON.stringify(oauth.status()).includes('SECRET-'));
  assert(!JSON.stringify(oauth.status()).includes('PRIVATE-IBAN'));
  assert.equal(oauth.status().organizationName, 'Lago SAS');
  assert.equal(oauth.status().state, 'choose_accounts');
  const tokenCall = calls.find(c => c.url.endsWith('/token'));
  assert.equal(tokenCall.options.body.get('client_secret'), 'SECRET-CLIENT');
  assert.equal(tokenCall.options.redirect, 'error');
  assert(!tokenCall.options.headers.authorization);
  config.qontoOAuth.encryptionKey = randomBytes(32).toString('hex');
  assert.throws(() => oauth.read(), /cannot be opened/);
  assert.equal(oauth.status().state, 'reconnect');
});
test('wrong organisation and unexpected write permissions are rejected', async t => {
  const {oauth, connect, responses} = setup(t);
  responses.organization = () => json({organization: {id: 'wrong-org'}});
  await assert.rejects(connect(), /does not match/); assert.equal(oauth.hasTokens(), false);
  responses.token = () => json({access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'organization.read offline_access payment.write'});
  await assert.rejects(connect(), /unexpected permissions/); assert.equal(oauth.hasTokens(), false);
});
test('provider error bodies and secrets are not reflected', async t => {
  const {connect, responses} = setup(t);
  responses.token = () => json({error_description: 'SECRET-CLIENT SECRET-REFRESH'}, 400);
  await assert.rejects(connect(), e => !e.message.includes('SECRET') && /authorization could not complete/.test(e.message));
});
test('expired access tokens refresh once concurrently and persist the rotated pair', async t => {
  const {oauth, connect, advance, calls} = setup(t); await connect(); advance(3600000);
  const result = await Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()]);
  assert.deepEqual(result, ['SECRET-ACCESS-2', 'SECRET-ACCESS-2', 'SECRET-ACCESS-2']);
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 2);
  assert.equal(oauth.read().refreshToken, 'SECRET-REFRESH-2');
  assert.equal(oauth.read().status, 'active');
});
test('ambiguous refresh fails closed without replaying a one-use token', async t => {
  const {oauth, connect, advance, responses, calls, store, config} = setup(t); await connect(); advance(3600000);
  responses.token = () => {throw new Error('network failed SECRET-REFRESH');};
  await assert.rejects(oauth.accessToken(), /could not be confirmed/);
  await assert.rejects(oauth.accessToken(), /Reconnect/);
  assert.equal(oauth.status().state, 'reconnect');
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 2);
  assert.match(sourceHold(store, config), /qonto/);
});
test('restart after in-flight refresh requires fresh consent', async t => {
  const {oauth, connect, store, config, fetcher, now} = setup(t); await connect();
  oauth.write({...oauth.read(), status: 'refreshing'});
  const restored = new QontoOAuth(store, config, {fetcher, now});
  await assert.rejects(restored.accessToken(), /Reconnect/);
  assert.equal(restored.status().state, 'reconnect');
});
test('refresh expiry requires consent without contacting token endpoint', async t => {
  const {oauth, connect, advance, calls} = setup(t); await connect(); advance(91 * 86400000);
  await assert.rejects(oauth.accessToken(), /Reconnect/);
  assert.equal(calls.filter(c => c.url.endsWith('/token')).length, 1);
});
test('account selection validates membership, resets watermark and invalidates healthy source', async t => {
  const {oauth, connect, store} = setup(t); await connect();
  await assert.rejects(oauth.selectAccounts([]), /Choose at least/);
  await assert.rejects(oauth.selectAccounts(['attacker-account']), /active account/);
  store.health('qonto', 'succeeded'); store.setSyncState('qonto');
  await oauth.selectAccounts(['account-1']);
  assert.equal(oauth.status().state, 'connected');
  assert.equal(store.getSyncState('qonto'), null);
  assert.equal(store.sourceHealth().find(s => s.source === 'qonto').status, 'failed');
});
test('selected accounts are enforced and Qonto documented rows without account IDs import', async t => {
  const {oauth, connect, responses} = setup(t); await connect(); await oauth.selectAccounts(['account-1']);
  const connector = new QontoConnector({oauth, baseUrl: oauth.apiBase}, (...args) => oauth.connectorRequest(...args));
  const rows = await connector.listIncoming();
  assert.equal(rows[0].accountId, 'account-1'); assert.equal(rows[0].amountCents, 20000);
  await assert.rejects(oauth.connectorRequest(`${oauth.apiBase}/transactions?bank_account_id=account-2&side=credit&status[]=completed`), /not permitted/);
  await assert.rejects(oauth.connectorRequest(`${oauth.apiBase}/transactions`, {method: 'POST'}), /Only Qonto/);
  await assert.rejects(oauth.connectorRequest('https://evil.example/v2/transactions'), /Only Qonto/);
  await assert.rejects(connector.getTransaction('unknown'), /previously imported/);
  responses.transactions = () => json({transactions: [{id: 't', bank_account_id: 'account-2', side: 'credit', status: 'completed'}]});
  await assert.rejects(connector.listIncoming(), /outside the selected/);
});
test('rechecking imported transaction binds detail reads to the selected account', async t => {
  const {oauth, connect, responses, store} = setup(t); await connect(); await oauth.selectAccounts(['account-1']);
  const connector = new QontoConnector({oauth, baseUrl: oauth.apiBase}, (...args) => oauth.connectorRequest(...args));
  const [row] = await connector.listIncoming(); store.upsertTransfer(row);
  responses.transactions = () => json({transaction: {id: 'tx-1', side: 'credit', status: 'reversed', amount_cents: 20000, currency: 'EUR'}});
  assert.equal((await connector.getTransaction('tx-1')).status, 'reversed');
  await oauth.selectAccounts(['account-2']);
  await assert.rejects(connector.getTransaction('tx-1'), /previously imported/);
});
test('disconnect revokes Qonto consent, deletes credentials and keeps source required on restart', async t => {
  const {oauth, connect, config, store, calls, fetcher, now} = setup(t); await connect();
  const result = await oauth.disconnect(); assert.equal(result.revoked, true); assert.equal(oauth.hasTokens(), false);
  assert.equal(calls.at(-1).options.method, 'DELETE'); assert(calls.at(-1).url.endsWith('/oauth2/consents'));
  assert(config.requiredSources.includes('qonto')); assert.match(sourceHold(store, config), /qonto/);
  config.qontoOAuth.clientId = ''; config.requiredSources = ['lago'];
  new QontoOAuth(store, config, {fetcher, now}); assert(config.requiredSources.includes('qonto'));
});
test('failed remote revocation still disconnects locally and reports unfinished revocation', async t => {
  const {oauth, connect, responses} = setup(t); await connect(); responses.revoke = () => json({}, 503);
  const result = await oauth.disconnect(); assert.equal(result.revoked, false);
  assert.match(result.message, /Remove this app in Qonto/); assert.equal(oauth.hasTokens(), false);
});
test('local access permits Qonto setup without workspace keys', t => {
  const {oauth,config}=setup(t);
  config.accessMode='local';config.adminKeys=[];
  assert.deepEqual(oauth.missing(),[]);
  assert(oauth.begin('http://localhost:4320').url.startsWith('https://oauth.qonto.com/'));
});
test('unconfigured, demo and mismatched callback origins cannot start a bank login', t => {
  const {oauth, config} = setup(t);
  assert.throws(() => oauth.begin('http://127.0.0.1:4320'), /Open the workspace/);
  config.mode = 'demo'; assert.throws(() => oauth.begin('http://localhost:4320'), /administrator to enable/);
  config.mode = 'connected'; config.qontoOAuth.redirectUri = 'http://evil.example/oauth/qonto/callback';
  assert.throws(() => oauth.begin('http://evil.example'), /administrator to enable/);
  assert.throws(() => loadConfig({APP_MODE: 'connected', APP_ACCESS_MODE: 'key', ADMIN_KEYS: ''}), /APP_ACCESS_MODE=key/);
});
test('model tool allowlists drop raw bank data, email, free-text cases and draft bodies', () => {
  const collection = {rows: [{customerName: 'Acme', invoices: [{number: 'INV-1'}], amountCents: 10, currency: 'EUR',
    recipient: 'PRIVATE-EMAIL', raw: 'PRIVATE-BANK', draft: {body: 'PRIVATE-DRAFT'}, reason: 'PRIVATE-NOTE'}]};
  const run = {result: {collection, private: 'PRIVATE-RUN'}};
  const snapshot = {collection, cases: [{raw: 'PRIVATE-CASE'}], receipts: [{raw: 'PRIVATE-RECEIPT', iban: 'PRIVATE-IBAN'}], runs: [run], sourceHealth: [{detail: 'PRIVATE-ERROR'}]};
  assert(!JSON.stringify(contextForModel(snapshot)).includes('PRIVATE-'));
  assert(!JSON.stringify(runForModel(run)).includes('PRIVATE-'));
  assert.equal(contextForModel(snapshot).collection.rows[0].invoiceNumbers[0], 'INV-1');
});

test('first consent discovers the organisation and pins it for all future connections', async t => {
  const {config, oauth, connect, begin, responses, store} = setup(t);
  config.qontoOAuth.organizationId = '';
  assert.equal(new URL(begin().flow.url).searchParams.has('organization_id'), false);
  await connect();
  assert.equal(store.meta('qontoOrganizationId'), 'org-lago');
  await oauth.disconnect();
  assert.equal(new URL(begin().flow.url).searchParams.get('organization_id'), 'org-lago');
  responses.organization = () => json({organization: {id: 'another-company'}});
  await assert.rejects(connect(), /does not match/);
});
test('ordinary connection status contains no developer setup instructions', t => {
  const {oauth, config} = setup(t);config.qontoOAuth.clientSecret = '';
  const status = oauth.status();
  assert.equal(status.state, 'setup');assert(!('missing' in status));assert(!('redirectUri' in status));
  assert(oauth.status({administrator: true}).missing.length);
});
