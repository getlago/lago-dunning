import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const SCOPES = ['organization.read', 'offline_access'];
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const QONTO_COOKIE = 'lago-qonto-oauth';

// Tokens are authenticated ciphertext; the encryption key is supplied separately
// from SQLite. One application process owns this database (see lock.js).
export class QontoOAuth {
  constructor(store, config, { fetcher = fetch, now = Date.now } = {}) {
    this.store = store; this.config = config; this.settings = config.qontoOAuth;
    this.fetcher = fetcher; this.now = now; this.pending = new Map(); this.refreshing = null;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS qonto_oauth (
      id INTEGER PRIMARY KEY CHECK(id=1), ciphertext TEXT NOT NULL
    )`);
    const sandbox = this.settings.environment === 'sandbox';
    this.oauthBase = sandbox ? 'https://oauth-sandbox.staging.qonto.co' : 'https://oauth.qonto.com';
    this.apiBase = sandbox ? 'https://thirdparty-sandbox.staging.qonto.co/v2' : 'https://thirdparty.qonto.com/v2';
    if (config.mode === 'connected' && (this.settings.clientId || config.qonto.token || this.hasTokens() || store.meta('qontoRequired'))) {
      if (!config.requiredSources.includes('qonto')) config.requiredSources.push('qonto');
    }
    if (this.config.mode === 'connected' && this.hasTokens()) {
      try {
        const record = this.read();
        if (record.status === 'refreshing') this.invalidate('Qonto renewal was interrupted. Reconnect to continue.');
      } catch { store.health('qonto', 'failed', 'Qonto credentials cannot be opened. Restore the encryption key or reconnect.'); }
    }
  }
  hasTokens() { return Boolean(this.store.db.prepare('SELECT id FROM qonto_oauth WHERE id=1').get()); }
  missing() {
    const s = this.settings, missing = [];
    if (this.config.mode !== 'connected') missing.push('Switch to the connected workspace');
    if (this.config.accessMode !== 'local' && !this.config.adminKeys.length) missing.push('Set a workspace access key');
    if (!s.clientId || !s.clientSecret) missing.push('Add the Qonto application credentials on the server');
    if (!/^[a-f0-9]{64}$/i.test(s.encryptionKey)) missing.push('Configure the server token encryption key');
    if (!['production', 'sandbox'].includes(s.environment)) missing.push('Choose a valid Qonto environment');
    if (s.environment === 'sandbox' && !this.config.qonto.stagingToken) missing.push('Add the Qonto sandbox staging token');
    try {
      const u = new URL(s.redirectUri);
      // This application is intentionally local. Do not weaken proxy/host checks
      // to add a public callback without implementing deployment authentication.
      if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) ||
          u.username || u.password || u.search || u.hash || u.pathname !== '/oauth/qonto/callback' ||
          Number(u.port) !== this.config.port) throw new Error();
    } catch { missing.push('Register the exact local callback address'); }
    return missing;
  }
  requireReady() { if (this.missing().length) throw fail('Qonto is not available yet. Ask your workspace administrator to enable the connection.'); }
  aad() { return Buffer.from(JSON.stringify(['qonto-v1', this.settings.clientId, this.settings.organizationId, this.apiBase])); }
  write(record) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.settings.encryptionKey, 'hex'), iv);
    cipher.setAAD(this.aad());
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const ciphertext = JSON.stringify({v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64')});
    this.store.db.prepare('INSERT INTO qonto_oauth VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext').run(ciphertext);
  }
  read() {
    const row = this.store.db.prepare('SELECT ciphertext FROM qonto_oauth WHERE id=1').get();
    if (!row) return null;
    try {
      const value = JSON.parse(row.ciphertext);
      if (value.v !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.settings.encryptionKey, 'hex'), Buffer.from(value.iv, 'base64'));
      decipher.setAAD(this.aad()); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw fail('Qonto credentials cannot be opened. Restore the encryption key or reconnect.'); }
  }
  status({ administrator = false } = {}) {
    const missing = this.missing();
    let record;
    try { record = this.read(); } catch { return {state: 'reconnect', ...(administrator ? {missing, redirectUri: this.settings.redirectUri} : {}),
      environment: this.settings.environment,
      message: 'This connection needs attention. Ask your administrator to restore it.',
      accounts: [], selected: [], canDisconnect: true}; }
    return {
      state: missing.length ? 'setup' : !record ? 'disconnected' : record.status === 'reconnect' ? 'reconnect' : record.selected.length ? 'connected' : 'choose_accounts',
      ...(administrator ? {missing, redirectUri: this.settings.redirectUri} : {}), environment: this.settings.environment,
      organizationName: record?.organizationName, accounts: record?.accounts ?? [], selected: record?.selected ?? [],
      connectedAt: record?.connectedAt, message: record?.message ?? this.store.meta('qontoDisconnectMessage'),
      canDisconnect: this.hasTokens(), lastSuccessAt: this.config.mode === 'connected' && record ? this.store.sourceHealth().find(s => s.source === 'qonto')?.last_success_at ?? null : null
    };
  }
  begin(requestOrigin) {
    this.requireReady();
    if (new URL(this.settings.redirectUri).origin !== requestOrigin) throw fail(`Open the workspace at ${new URL(this.settings.redirectUri).origin} before connecting.`);
    if (this.hasTokens() && this.status().state !== 'reconnect') throw fail('Disconnect the existing Qonto connection before replacing it.');
    for (const [key, flow] of this.pending) if (flow.expires <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 20) throw fail('Too many connection attempts. Try again in ten minutes.', 429);
    const state = randomBytes(32).toString('hex'), binding = randomBytes(32).toString('hex');
    this.pending.set(state, {binding, expires: this.now() + 600_000});
    const url = new URL(`${this.oauthBase}/oauth2/auth`);
    const parameters = new URLSearchParams({client_id: this.settings.clientId, redirect_uri: this.settings.redirectUri,
      response_type: 'code', scope: SCOPES.join(' '), state});
    const organizationId = this.settings.organizationId || this.store.meta('qontoOrganizationId');
    if (organizationId) parameters.set('organization_id', organizationId);
    url.search = parameters;
    return {url: url.href, cookie: `${QONTO_COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=/oauth/qonto/callback; Max-Age=600`};
  }
  async complete(params, binding) {
    this.requireReady();
    const state = params.get('state'), flow = this.pending.get(state);
    if (!flow || flow.expires <= this.now() || !safeEqual(flow.binding, binding)) throw fail('Qonto login expired or could not be verified. Start again.', 403);
    this.pending.delete(state); // A code and state may only be used once, even on failure.
    if (params.has('error')) throw fail('Qonto access was not granted. You can try connecting again.');
    const code = params.get('code');
    if (!code || code.length > 4096) throw fail('Qonto did not return a valid authorization code.');
    const tokens = await this.exchange({grant_type: 'authorization_code', code, redirect_uri: this.settings.redirectUri});
    const result = await this.api('/organization', tokens.accessToken);
    const org = result?.organization;
    const expectedOrganization = this.settings.organizationId || this.store.meta('qontoOrganizationId');
    if (!org?.id || (expectedOrganization && org.id !== expectedOrganization)) throw fail('The Qonto organisation does not match this workspace’s connected organisation.');
    const accounts = await this.listAccounts(tokens.accessToken);
    if (!accounts.length) throw fail('No active Qonto account is available to connect.');
    // Reset the watermark: a newly selected account must get its full history.
    this.write({...tokens, organizationName: String(org.legal_name ?? org.name ?? 'Lago'), accounts, selected: [], status: 'active', connectedAt: new Date(this.now()).toISOString()});
    this.store.meta('qontoOrganizationId', org.id);
    this.store.meta('qontoRequired', true); this.store.meta('qontoDisconnectMessage', null);
    if (!this.config.requiredSources.includes('qonto')) this.config.requiredSources.push('qonto');
    this.store.health('qonto', 'failed', 'Choose the Qonto accounts to reconcile.');
    this.pending.clear();
  }
  async exchange(parameters) {
    let response, body;
    try {
      response = await this.fetcher(`${this.oauthBase}/oauth2/token`, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...this.stagingHeaders()},
        body: new URLSearchParams({...parameters, client_id: this.settings.clientId, client_secret: this.settings.clientSecret})});
      if (!response.ok) throw new Error();
      body = await response.json();
    } catch { throw fail('Qonto authorization could not complete. Reconnect to continue.'); }
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/) : SCOPES;
    if (!body.access_token || !body.refresh_token || String(body.token_type).toLowerCase() !== 'bearer' ||
        !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0 ||
        !SCOPES.every(s => scopes.includes(s)) || scopes.some(s => !SCOPES.includes(s))) {
      throw fail('Qonto returned incomplete credentials or unexpected permissions. Check the read-only application scopes.');
    }
    return {accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: this.now() + Number(body.expires_in) * 1000, refreshExpiresAt: this.now() + 90 * 86400000};
  }
  stagingHeaders() { return this.settings.environment === 'sandbox' ? {'x-qonto-staging-token': this.config.qonto.stagingToken} : {}; }
  invalidate(message) {
    const record = this.read();
    if (record) this.write({...record, status: 'reconnect', message});
    this.store.health('qonto', 'failed', message);
  }
  async accessToken() {
    this.requireReady();
    if (this.refreshing) return this.refreshing;
    const record = this.read();
    if (!record || record.status === 'reconnect') throw fail('Reconnect Qonto to refresh payment evidence.');
    if (record.status === 'refreshing' || record.refreshExpiresAt <= this.now()) {
      this.invalidate('Qonto authorization expired or renewal was interrupted. Reconnect to continue.');
      throw fail('Reconnect Qonto to continue.');
    }
    if (record.expiresAt > this.now() + 60000) return record.accessToken;
    // Persist the in-flight state before consuming a one-use refresh token.
    this.write({...record, status: 'refreshing'});
    this.refreshing = (async () => {
      try {
        const tokens = await this.exchange({grant_type: 'refresh_token', refresh_token: record.refreshToken});
        this.write({...record, ...tokens, status: 'active', message: null});
        return tokens.accessToken;
      } catch {
        this.invalidate('Qonto renewal could not be confirmed. Reconnect to continue.');
        throw fail('Qonto renewal could not be confirmed. Reconnect to continue.');
      }
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async api(route, token, method = 'GET') {
    let response;
    try {
      response = await this.fetcher(`${this.apiBase}${route}`, {method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {authorization: `Bearer ${token}`, accept: 'application/json', ...this.stagingHeaders()}});
    } catch { throw fail('Qonto is unavailable. Payment checks remain blocked.', 502); }
    if (!response.ok) {
      if ([401, 403].includes(response.status) && this.hasTokens()) this.invalidate('Qonto access needs attention. Reconnect to continue.');
      throw fail('Qonto could not verify payment data. Check the connection and try again.', 502);
    }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw fail('Qonto returned an invalid response.', 502); }
  }
  async listAccounts(token) {
    const accounts = [], seen = new Set(); let page = 1;
    for (;;) {
      if (seen.has(page) || seen.size >= 100) throw fail('Qonto account pagination could not be completed.');
      seen.add(page);
      const body = await this.api(`/bank_accounts?per_page=100&page=${page}`, token);
      if (!Array.isArray(body.bank_accounts)) throw fail('Qonto returned an invalid account list.');
      for (const a of body.bank_accounts) if (a.id && (!a.status || a.status === 'active')) accounts.push({id: a.id, name: String(a.name ?? 'Bank account'), currency: String(a.currency ?? '')});
      if (!body.meta?.next_page) return accounts;
      page = Number(body.meta.next_page);
      if (!Number.isSafeInteger(page) || page < 1) throw fail('Qonto returned an invalid account page.');
    }
  }
  async selectAccounts(ids) {
    this.requireReady();
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw fail('Choose at least one Qonto account.', 400);
    const accounts = await this.listAccounts(await this.accessToken());
    if (ids.some(id => !accounts.some(a => a.id === id))) throw fail('Choose an active account from the connected Qonto organisation.', 400);
    this.write({...this.read(), accounts, selected: [...new Set(ids)]});
    this.store.db.prepare("DELETE FROM sync_state WHERE provider='qonto'").run();
    this.store.health('qonto', 'failed', 'Accounts changed. Run a fresh reconciliation before collecting.');
    return this.status();
  }
  selectedAccounts() {
    this.requireReady();
    const record = this.read();
    if (!record || record.status === 'reconnect' || !record.selected.length) throw fail('Connect Qonto and choose accounts before reconciling.');
    return record.selected;
  }
  async connectorRequest(url, options = {}) {
    const target = new URL(url), base = new URL(this.apiBase);
    if ((options.method ?? 'GET') !== 'GET' || target.origin !== base.origin || target.username || target.password || target.hash ||
        !/^\/v2\/transactions(?:\/[^/]+)?$/.test(target.pathname)) throw fail('Only Qonto transaction reads are permitted.', 403);
    const ids = this.selectedAccounts();
    const isList = target.pathname === '/v2/transactions';
    const transactionId = isList ? null : decodeURIComponent(target.pathname.slice('/v2/transactions/'.length));
    const known = isList ? null : this.store.db.prepare("SELECT account_id FROM transfers WHERE provider='qonto' AND provider_transaction_id=?").all(transactionId);
    if (!isList && (known.length !== 1 || known.some(t => !ids.includes(t.account_id)))) throw fail('Only previously imported payments from selected accounts can be rechecked.', 403);
    if (target.pathname === '/v2/transactions' && (!ids.includes(target.searchParams.get('bank_account_id')) ||
        target.searchParams.get('side') !== 'credit' || target.searchParams.get('status[]') !== 'completed')) throw fail('This account or transaction query is not permitted.', 403);
    const result = await this.api(target.pathname.slice('/v2'.length) + target.search, await this.accessToken());
    const rows = isList ? result.transactions : [result.transaction ?? result];
    const accountId = isList ? target.searchParams.get('bank_account_id') : known[0].account_id;
    // Qonto's documented transaction response omits bank_account_id. For list
    // responses the authenticated account-filtered request supplies it; detail
    // reads must already belong to an imported payment in that selected account.
    if (!Array.isArray(rows) || rows.some(row => (row.bank_account_id && row.bank_account_id !== accountId) || row.side !== 'credit' ||
        (!isList && String(row.id ?? row.transaction_id) !== transactionId) || (isList && row.status !== 'completed'))) throw fail('Qonto returned payment data outside the selected accounts.', 502);
    for (const row of rows) row.bank_account_id = accountId;
    return result;
  }
  async disconnect() {
    let revoked = false;
    try { await this.api('/oauth2/consents', await this.accessToken(), 'DELETE'); revoked = true; } catch { /* Always disable local access even if Qonto is unavailable. */ }
    this.store.db.prepare('DELETE FROM qonto_oauth').run(); this.pending.clear();
    const message = revoked ? 'Disconnected. Qonto access has been revoked.' : 'Disconnected locally. Remove this app in Qonto too: remote revocation could not be confirmed.';
    this.store.meta('qontoDisconnectMessage', message);
    this.store.health('qonto', 'failed', 'Qonto is disconnected. Reconnect before collecting.');
    return {revoked, message};
  }
}
