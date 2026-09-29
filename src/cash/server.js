import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ReconciliationStore } from './db.js';
import { LagoConnector } from './connectors/lago.js';
import { MercuryConnector } from './connectors/mercury.js';
import { QontoConnector } from './connectors/qonto.js';
import { BrexConnector } from './connectors/brex.js';
import { RampConnector } from './connectors/ramp.js';
import { StripeConnector } from './connectors/stripe.js';
import { SalesforceConnector } from './connectors/salesforce.js';
import { BusinessCentralConnector, NetSuiteConnector, QuickBooksConnector, SapConnector, XeroConnector } from './connectors/erp.js';
import { ReconciliationService } from './service.js';
import { ReconciliationAgent } from './agent/orchestrator.js';
import { AgentWorker } from './agent/worker.js';
import { authorizeLocalRequest, requireLiveAdmin, requirePermission } from './local-auth.js';

const config = loadConfig();
const store = new ReconciliationStore(config.databasePath);
const service = new ReconciliationService({
  store,
  lago: new LagoConnector(config.lago),
  mercury: new MercuryConnector(config.mercury),
  qonto: new QontoConnector(config.qonto),
  brex: new BrexConnector(config.brex),
  ramp: new RampConnector(config.ramp),
  stripe: new StripeConnector(config.stripe),
  salesforce: new SalesforceConnector(config.salesforce),
  erps: {
    xero: new XeroConnector(config.erps.xero),
    quickbooks: new QuickBooksConnector(config.erps.quickbooks),
    business_central: new BusinessCentralConnector(config.erps.businessCentral),
    netsuite: new NetSuiteConnector(config.erps.netsuite),
    sap: new SapConnector(config.erps.sap)
  },
  stripeCustomerMap: config.stripe.customerMap,
  dryRun: config.dryRun
});
const agent = new ReconciliationAgent({ store, service, config: config.agent });
const worker = new AgentWorker({ agent, intervalMs: config.agent.intervalMs, runOnStart: config.agent.runOnStart });
if (config.agent.enabled) worker.start();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error({ message: error.message, status: error.status ?? 500 });
    json(response, error.status ?? 500, { error: error.message });
  }
});

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const principal = url.pathname.startsWith('/api/') ? authorizeLocalRequest(request, config) : null;
  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return json(response, 200, {
      dryRun: config.dryRun,
      stats: store.stats(),
      receipts: store.listReceipts(),
      openInvoices: store.getOpenInvoices(),
      transfers: store.listTransfers(url.searchParams.get('status') || undefined),
      incidents: store.listIncidents('open'),
      externalPayments: store.listExternalPayments(),
      customerContexts: store.listCustomerContexts(),
      agentRun: store.getLatestAgentRun(),
      agentCases: store.listAgentCases('open'),
      identityEdges: store.listIdentityEdges(),
      agentMetrics: store.getAgentOutcomeMetrics(),
      pilotReadiness: store.getPilotReadiness(),
      agentStatus: worker.status()
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/receipts') {
    return json(response, 200, { receipts: store.listReceipts() });
  }

  if (request.method === 'GET' && url.pathname.match(/^\/api\/receipts\/[^/]+$/)) {
    const receiptId = decodeURIComponent(url.pathname.split('/')[3]);
    const receipt = store.getReceipt(receiptId);
    return receipt ? json(response, 200, { receipt }) : json(response, 404, { error: 'Receipt not found' });
  }

  if (request.method === 'POST' && url.pathname.match(/^\/api\/receipts\/[^/]+\/evidence$/)) {
    requirePermission(principal, 'payments:view');
    const receiptId = decodeURIComponent(url.pathname.split('/')[3]);
    const payload = await readJson(request);
    return json(response, 201, { evidence: service.attachReceiptEvidence(receiptId, payload, principal.actor) });
  }

  if (request.method === 'POST' && url.pathname.match(/^\/api\/receipts\/[^/]+\/remittance$/)) {
    requirePermission(principal, 'payments:view');
    const receiptId = decodeURIComponent(url.pathname.split('/')[3]);
    const payload = await readJson(request);
    return json(response, 201, service.ingestRemittanceDocument(receiptId, payload, principal.actor));
  }

  if (request.method === 'GET' && url.pathname === '/api/cash-application/policies') {
    return json(response, 200, { policies: store.listCashApplicationPolicies(false) });
  }

  if (request.method === 'POST' && url.pathname === '/api/cash-application/policies') {
    requireAdmin(principal);
    const payload = await readJson(request);
    return json(response, 201, service.configureCashApplicationPolicy(payload, principal.actor));
  }

  if (request.method === 'GET' && url.pathname.match(/^\/api\/incidents\/[^/]+\/repair-preview$/)) {
    const incidentId = decodeURIComponent(url.pathname.split('/')[3]);
    return json(response, 200, service.previewRepair(incidentId));
  }

  if (request.method === 'GET' && url.pathname === '/api/external-payments') {
    return json(response, 200, { payments: store.listExternalPayments(url.searchParams.get('provider')) });
  }

  if (request.method === 'POST' && url.pathname.match(/^\/api\/transfers\/[^/]+\/rematch$/)) {
    requirePermission(principal, 'payments:view');
    const transferId = decodeURIComponent(url.pathname.split('/')[3]);
    return json(response, 200, { proposals: service.matchTransfer(transferId) });
  }

  if (request.method === 'POST' && url.pathname === '/api/reviews') {
    const payload = await readJson(request);
    if (payload.action === 'approve') {
      requirePermission(principal, 'payments:create');
      if (payload.execute) requireLiveAdmin(principal, config);
      return json(response, 200, await service.approve({ ...payload, actor: principal.actor }));
    }
    requirePermission(principal, 'payments:view');
    if (payload.action === 'reject') return json(response, 200, service.reject({ ...payload, actor: principal.actor }));
    if (payload.action === 'hold') return json(response, 200, service.hold({ ...payload, actor: principal.actor }));
    return json(response, 400, { error: 'Unknown review action' });
  }

  if (request.method === 'POST' && url.pathname.match(/^\/api\/decisions\/\d+\/execute$/)) {
    requireLiveAdmin(principal, config);
    const decisionId = Number(url.pathname.split('/')[3]);
    return json(response, 200, await service.executeDecision(decisionId, principal.actor));
  }

  if (request.method === 'POST' && url.pathname.match(/^\/api\/decisions\/\d+\/void$/)) {
    requirePermission(principal, 'payments:create');
    const decisionId = Number(url.pathname.split('/')[3]);
    const payload = await readJson(request);
    return json(response, 200, service.voidApproval({ decisionId, actor: principal.actor, reason: payload.reason }));
  }

  if (request.method === 'POST' && url.pathname === '/api/sync/lago') {
    requireAdmin(principal);
    return json(response, 200, await service.syncInvoices());
  }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/sync\/(mercury|qonto|brex|ramp)$/)) {
    requireAdmin(principal);
    return json(response, 200, await service.syncProvider(url.pathname.split('/').at(-1)));
  }
  if (request.method === 'POST' && url.pathname === '/api/import/statement') {
    requireAdmin(principal);
    const payload = await readJson(request);
    return json(response, 201, service.importStatementFile(payload, principal.actor));
  }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/sync\/erp\/(xero|quickbooks|business_central|netsuite|sap)$/)) {
    requireAdmin(principal);
    return json(response, 200, await service.syncErp(url.pathname.split('/').at(-1)));
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/stripe') {
    requireAdmin(principal);
    const payload = await readJson(request);
    return json(response, 200, await service.syncStripe(payload.customerId ?? null));
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/salesforce') {
    requireAdmin(principal);
    return json(response, 200, await service.syncSalesforce());
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/run') {
    requireAdmin(principal);
    const payload = await readJson(request);
    return json(response, 200, await agent.run({
      trigger: payload.trigger ?? 'manual', sync: payload.sync !== false,
      sources: Array.isArray(payload.sources) ? payload.sources : null
    }));
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/latest') {
    const run = store.getLatestAgentRun();
    return run ? json(response, 200, { ...run, cases: store.listAgentCases('open') }) : json(response, 404, { error: 'No agent run yet' });
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/status') {
    return json(response, 200, { worker: worker.status(), latestRun: store.getLatestAgentRun() });
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/metrics') {
    return json(response, 200, store.getAgentOutcomeMetrics());
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/readiness') {
    return json(response, 200, store.getPilotReadiness());
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/cases') {
    return json(response, 200, { cases: store.listAgentCases(url.searchParams.get('state') || null) });
  }
  if (request.method === 'GET' && url.pathname.match(/^\/api\/agent\/cases\/[^/]+$/)) {
    const caseId = decodeURIComponent(url.pathname.split('/')[4]);
    const item = store.getAgentCase(caseId);
    return item ? json(response, 200, item) : json(response, 404, { error: 'Agent case not found' });
  }
  if (request.method === 'GET' && url.pathname.match(/^\/api\/agent\/cases\/[^/]+\/workpaper$/)) {
    const caseId = decodeURIComponent(url.pathname.split('/')[4]);
    const item = store.getAgentCase(caseId);
    return item ? json(response, 200, {
      generatedAt: new Date().toISOString(), policyVersion: store.getLatestAgentRun()?.policyVersion,
      case: item, controls: { sourceCitationsRequired: true, approvalRequired: true, autonomousWrites: false }
    }) : json(response, 404, { error: 'Agent case not found' });
  }
  if (request.method === 'POST' && url.pathname.match(/^\/api\/agent\/cases\/[^/]+\/actions$/)) {
    const caseId = decodeURIComponent(url.pathname.split('/')[4]);
    const payload = await readJson(request);
    if (payload.execute) requireLiveAdmin(principal, config);
    return json(response, 200, await agent.act(caseId, {
      ...payload, actor: principal.actor, actorPermissions: principal.permissions
    }));
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/identity-graph') {
    return json(response, 200, { edges: store.listIdentityEdges() });
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/playbooks') {
    return json(response, 200, { playbooks: store.listAgentPlaybooks() });
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/playbooks') {
    requireAdmin(principal);
    const payload = await readJson(request);
    if (!payload.id || !payload.name) return json(response, 400, { error: 'Playbook id and name are required' });
    const playbook = store.upsertAgentPlaybook({ ...payload, createdBy: principal.actor });
    store.audit('agent_playbook_upserted', 'agent_playbook', playbook.id, principal.actor, { version: playbook.version, name: playbook.name });
    return json(response, 201, playbook);
  }

  if (request.method === 'POST' && url.pathname.match(/^\/webhooks\/(mercury|qonto)$/)) {
    const provider = url.pathname.split('/').at(-1);
    const rawBody = await readBody(request);
    const signature = provider === 'mercury' ? request.headers['mercury-signature'] : request.headers['x-qonto-signature'];
    const result = await service.processWebhook(provider, rawBody, signature);
    if (config.agent.enabled && !result.duplicate) worker.trigger(`webhook:${provider}`);
    return json(response, 202, result);
  }

  if (request.method === 'GET') return staticFile(response, url.pathname);
  return json(response, 404, { error: 'Not found' });
}

function requireAdmin(principal) {
  if (!principal?.isAdmin) throw Object.assign(new Error('Local administrator access is required'), { status: 403 });
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const raw = await readBody(request);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function staticFile(response, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const candidate = path.resolve(publicDir, name);
  if (!candidate.startsWith(`${publicDir}${path.sep}`) && candidate !== path.join(publicDir, 'index.html')) {
    return json(response, 403, { error: 'Forbidden' });
  }
  if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) return json(response, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': types[path.extname(candidate)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(candidate).pipe(response);
}

function json(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

server.listen(config.port, config.host, () => {
  console.log(`Lago Cash Application listening on http://${config.host}:${config.port} (${config.dryRun ? 'dry run' : 'LIVE'})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => { store.close(); process.exit(0); });
    worker.stop();
  });
}
