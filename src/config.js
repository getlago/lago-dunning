import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig as cashConfig } from './cash/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig(env = process.env) {
  const mode = env.APP_MODE ?? 'connected';
  if (!['demo', 'connected'].includes(mode)) throw new Error('APP_MODE must be demo or connected');
  const config = cashConfig({ cwd: ROOT, env: { ...env, DRY_RUN: 'true', HOST: '127.0.0.1' } });
  config.mode = mode;
  config.host = '127.0.0.1';
  config.port = Number(env.PORT ?? 4320);
  config.databasePath = path.resolve(ROOT, env.DATABASE_PATH ?? `data/${mode}.db`);
  config.allowLive = mode === 'connected' && env.ALLOW_LIVE_ACTIONS === 'true';
  config.dryRun = !config.allowLive;
  config.adminKeys = (env.ADMIN_KEYS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  config.accessMode = env.APP_ACCESS_MODE ?? (config.adminKeys.length ? 'key' : 'local');
  if (!['local', 'key'].includes(config.accessMode)) throw new Error('APP_ACCESS_MODE must be local or key');
  if (config.accessMode === 'key' && !config.adminKeys.length) throw new Error('Set ADMIN_KEYS when APP_ACCESS_MODE=key');
  config.providerSettingsPath = env.PROVIDER_SETTINGS_PATH ?? path.join(ROOT, '.secrets');
  // Reverse-proxy exposure: exact public origins browsers will use, and whether forwarded headers
  // from a proxy on this machine are tolerated. The listener stays on loopback either way.
  config.publicOrigins = (env.PUBLIC_ORIGIN ?? '').split(',').map(x => x.trim()).filter(Boolean).map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`PUBLIC_ORIGIN entry is not a URL: ${value}`); }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error(`PUBLIC_ORIGIN entries must be plain https origins: ${value}`);
    return url.origin;
  });
  config.trustProxy = env.TRUST_PROXY === 'true';
  config.qontoConnectionMode = env.QONTO_CONNECTION_MODE ?? (config.qonto.token ? 'api_key' : 'oauth');
  if (!['api_key', 'oauth'].includes(config.qontoConnectionMode)) throw new Error('QONTO_CONNECTION_MODE must be api_key or oauth');
  config.qontoOAuth = {
    clientId: env.QONTO_CLIENT_ID ?? '', clientSecret: env.QONTO_CLIENT_SECRET ?? '',
    organizationId: env.QONTO_ORGANIZATION_ID ?? '',
    redirectUri: env.QONTO_REDIRECT_URI ?? `http://localhost:${config.port}/oauth/qonto/callback`,
    encryptionKey: env.QONTO_TOKEN_ENCRYPTION_KEY ?? '',
    environment: env.QONTO_ENVIRONMENT ?? 'production'
  };
  config.qontoSandboxOAuth = {
    clientId: env.QONTO_SANDBOX_CLIENT_ID ?? '', clientSecret: env.QONTO_SANDBOX_CLIENT_SECRET ?? '',
    organizationId: '', redirectUri: config.qontoOAuth.redirectUri,
    encryptionKey: config.qontoOAuth.encryptionKey, environment: 'sandbox',
    stagingToken: env.QONTO_SANDBOX_STAGING_TOKEN ?? env.QONTO_STAGING_TOKEN ?? ''
  };
  if (config.qontoOAuth.environment === 'sandbox') {
    Object.assign(config.qontoSandboxOAuth, {...config.qontoOAuth, stagingToken: config.qontoSandboxOAuth.stagingToken});
    config.qontoOAuth = {...config.qontoOAuth, environment: 'production', clientId: '', clientSecret: '', organizationId: ''};
  }
  config.requiredSources = (env.REQUIRED_PAYMENT_SOURCES ?? 'lago').split(',').map(x => x.trim()).filter(Boolean);
  config.maxSourceAgeMs = Number(env.MAX_SOURCE_AGE_MINUTES ?? 15) * 60_000;
  config.timezone = env.APP_TIMEZONE ?? 'Europe/Paris';
  config.policy = {
    weeklyCap: Number(env.MAX_TOUCHES_PER_WEEK ?? 2), dedupHours: Number(env.DEDUP_WINDOW_HOURS ?? 48),
    terminalTouches: Number(env.TERMINAL_TOUCHES ?? 3), materiality: Number(env.MATERIALITY_CENTS ?? 1000000),materialityCurrency:env.MATERIALITY_CURRENCY??'EUR',
    retryCap: Number(env.RETRY_AUTO_CAP_CENTS ?? 200000)
  };
  const localPython = path.join(ROOT, '.venv/bin/python');
  config.python = env.PYTHON_PATH ?? (fs.existsSync(localPython) ? localPython : 'python3');
  config.modelProvider = env.MODEL_PROVIDER ?? 'bedrock';
  config.modelRegion = env.AWS_DEFAULT_REGION ?? 'us-east-1';
  config.bedrockApiKey = env.AWS_BEARER_TOKEN_BEDROCK ?? '';
  config.modelName = config.modelProvider === 'anthropic' ? (env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5') :
    (env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  config.modelReady = Boolean(config.modelProvider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.AWS_BEARER_TOKEN_BEDROCK);
  config.smtp = {host:env.LAGO_SMTP_ADDRESS??'',port:Number(env.LAGO_SMTP_PORT??587),
    username:env.LAGO_SMTP_USERNAME??env.SMTP_USERNAME??'',password:env.LAGO_SMTP_PASSWORD??env.SMTP_PASSWORD??'',
    from:env.LAGO_FROM_EMAIL??env.MAIL_FROM??'',security:env.SMTP_SSL==='true'?'tls':env.SMTP_STARTTLS==='false'?'none':'starttls'};
  return config;
}
