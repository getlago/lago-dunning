import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { QontoOAuth } from './qonto-oauth.js';
import { QontoConnector } from './cash/connectors/qonto.js';
import { lockDatabase } from './lock.js';

const error = message => Object.assign(new Error(message), {status: 409});

// App-owner configuration, separate from customer connection tokens and financial
// databases. No secrets are returned by the administrator API after saving.
export class QontoSettings {
  constructor(config) {
    this.config = config;
    this.directory = config.providerSettingsPath;
    this.filename = path.join(this.directory, 'qonto.enc');
    this.keyfile = path.join(this.directory, 'qonto.key');
    this.profiles = {};
    this.managed = {production: Boolean(config.qontoOAuth.clientId || config.qontoOAuth.clientSecret),
      sandbox: Boolean(config.qontoSandboxOAuth.clientId || config.qontoSandboxOAuth.clientSecret)};
    if (fs.existsSync(this.filename)) {
      try {
        const record = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(record.iv, 'hex'));
        decipher.setAAD(Buffer.from('lago-qonto-settings-v1'));
        decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
        this.profiles = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString());
      } catch { throw error('Qonto administrator settings could not be opened. Restore the server key.'); }
    }
    this.apply('production'); this.apply('sandbox');
  }
  key(create = false) {
    if (create) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    if (create && !fs.existsSync(this.keyfile)) {
      const fd = fs.openSync(this.keyfile, 'wx', 0o600);
      try {fs.writeFileSync(fd, randomBytes(32));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    }
    const key = fs.readFileSync(this.keyfile);
    if (key.length !== 32) throw error('The Qonto server key is invalid.');
    return key;
  }
  apply(environment) {
    const target = environment === 'sandbox' ? this.config.qontoSandboxOAuth : this.config.qontoOAuth;
    const saved = this.profiles[environment];
    if (!saved) return;
    // Explicit environment variables take precedence over the admin form.
    target.clientId ||= saved.clientId;
    target.clientSecret ||= saved.clientSecret;
    target.encryptionKey ||= this.key().toString('hex');
    if (environment === 'sandbox') target.stagingToken ||= saved.stagingToken;
  }
  status() {
    return Object.fromEntries(['production', 'sandbox'].map(environment => {
      const s = environment === 'sandbox' ? this.config.qontoSandboxOAuth : this.config.qontoOAuth;
      return [environment, {clientId: s.clientId, managed: this.managed[environment], configured: Boolean(s.clientId && s.clientSecret && s.encryptionKey &&
        (environment !== 'sandbox' || s.stagingToken)), redirectUri: s.redirectUri}];
    }));
  }
  save(environment, data) {
    if (!['production', 'sandbox'].includes(environment)) throw error('Choose Production or Sandbox.');
    const target = environment === 'sandbox' ? this.config.qontoSandboxOAuth : this.config.qontoOAuth;
    const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
    const clientSecret = data.clientSecret || target.clientSecret;
    const stagingToken = data.stagingToken || target.stagingToken;
    if (!clientId || clientId.length > 200 || typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 8000 ||
        (environment === 'sandbox' && (typeof stagingToken !== 'string' || !stagingToken || stagingToken.length > 8000))) {
      throw error('Enter the application credentials from your Qonto developer portal.');
    }
    if (this.managed[environment]) throw error('These credentials are managed through server configuration. Update them there.');
    if (target.clientId && clientId !== target.clientId && !data.clientSecret) throw error('Enter the secret for the new application client ID.');
    const profiles = {...this.profiles, [environment]: {clientId, clientSecret, ...(environment === 'sandbox' ? {stagingToken} : {})}};
    const key = this.key(true), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('lago-qonto-settings-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(profiles)), cipher.final()]);
    const temporary = `${this.filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {fs.writeFileSync(fd, JSON.stringify({iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('base64')}));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      fs.renameSync(temporary, this.filename);
    } finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
    this.profiles = profiles;
    Object.assign(target, profiles[environment], {encryptionKey: target.encryptionKey || key.toString('hex')});
    return this.status();
  }
}

// Sandbox credentials and consent are isolated from the active workspace. Testing
// never imports payments, updates source health, or changes dunning in that workspace.
export class QontoSandbox {
  constructor(config) {
    this.config = {...config, mode: 'connected', allowLive: false, requiredSources: [],
      qontoOAuth: config.qontoSandboxOAuth, qonto: {...config.qonto, token: '', stagingToken: config.qontoSandboxOAuth.stagingToken}};
    const filename = `${config.databasePath}.qonto-sandbox`;
    this.unlock = lockDatabase(filename);
    try {this.store = new Store(filename);this.oauth = new QontoOAuth(this.store, this.config);}
    catch (e) {this.store?.close();this.unlock();throw e;}
    this.connector = new QontoConnector({baseUrl: this.oauth.apiBase, oauth: this.oauth}, (...args) => this.oauth.connectorRequest(...args));
  }
  async sync() {
    try {
      const rows = await this.connector.listIncoming();
      const summary = {count: rows.length, checkedAt: new Date().toISOString()};
      this.store.meta('lastSandboxTest', summary);
      this.store.health('qonto', 'succeeded');
      return summary;
    } catch (e) {
      this.store.meta('lastSandboxTest', null);this.store.health('qonto', 'failed');throw e;
    }
  }
  status() {return {...this.oauth.status(), test: this.store.sourceHealth().some(s => s.source === 'qonto' && s.status === 'succeeded') ? this.store.meta('lastSandboxTest') : null};}
  close() {this.store.close();this.unlock();}
}
