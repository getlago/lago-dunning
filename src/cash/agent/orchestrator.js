import { buildIdentityGraph, graphSummary } from './identity-graph.js';
import { AGENT_POLICY_VERSION, investigateReconciliation, summarizeInvestigations } from './investigator.js';
import { applyPlaybooks } from './playbooks.js';

export class ReconciliationAgent {
  constructor({ store, service, config = {} }) {
    this.store = store;
    this.service = service;
    this.config = config;
    this.running = false;
  }

  sourceTools() {
    const service = this.service;
    return [
      tool('lago', 'billing', configured(service.lago, 'apiKey'), () => service.syncInvoices()),
      tool('salesforce', 'crm', configured(service.salesforce, 'token', 'instanceUrl'), () => service.syncSalesforce()),
      tool('mercury', 'bank', configured(service.mercury, 'token'), () => this.syncBankIncrementally('mercury')),
      tool('qonto', 'bank', configured(service.qonto, 'token'), () => this.syncBankIncrementally('qonto')),
      tool('brex', 'bank', configured(service.brex, 'token'), () => service.syncProvider('brex')),
      tool('ramp', 'bank', configured(service.ramp, 'token', 'receiptsPath'), () => service.syncProvider('ramp')),
      tool('stripe', 'processor', configured(service.stripe, 'apiKey') && Object.keys(service.stripeCustomerMap ?? {}).length > 0, () => service.syncStripe()),
      tool('xero', 'erp', configured(service.erps?.xero, 'token', 'tenantId'), () => service.syncErp('xero')),
      tool('quickbooks', 'erp', configured(service.erps?.quickbooks, 'token', 'realmId'), () => service.syncErp('quickbooks')),
      tool('business_central', 'erp', configured(service.erps?.business_central, 'token', 'companyId', 'journalId'), () => service.syncErp('business_central')),
      tool('netsuite', 'erp', configured(service.erps?.netsuite, 'token', 'accountId', 'baseUrl'), () => service.syncErp('netsuite')),
      tool('sap', 'erp', configured(service.erps?.sap, 'token', 'systemId'), () => service.syncErp('sap'))
    ];
  }

  async syncBankIncrementally(provider) {
    const startedAt = new Date().toISOString();
    const state = this.store.getSyncState(provider);
    const options = provider === 'mercury'
      ? { postedStart: state?.lastSyncedAt }
      : provider === 'qonto' ? { updatedAtFrom: state?.lastSyncedAt } : {};
    const result = await this.service.syncProvider(provider, options);
    this.store.setSyncState(provider, { lastSyncedAt: startedAt });
    return { ...result, incrementalFrom: state?.lastSyncedAt ?? null, watermark: startedAt };
  }

  async run({ trigger = 'manual', sync = true, sources = null } = {}) {
    if (this.running) {
      const error = new Error('A reconciliation agent run is already in progress');
      error.status = 409;
      throw error;
    }
    this.running = true;
    const tools = this.sourceTools();
    const configuredSources = this.config.sources?.length ? this.config.sources : null;
    const selected = new Set(sources ?? configuredSources ?? tools.map((item) => item.name));
    const sourcePlan = tools.map((item) => ({ name: item.name, category: item.category, selected: sync && selected.has(item.name), configured: item.configured }));
    const runId = this.store.startAgentRun({ trigger, policyVersion: AGENT_POLICY_VERSION, sourcePlan });
    const stepResults = [];
    let sequence = 0;

    const step = async (toolName, category, input, operation, skipReason = null) => {
      sequence += 1;
      if (skipReason) {
        const result = { toolName, category, status: 'skipped', output: { reason: skipReason } };
        this.store.recordAgentStep({ runId, sequence, ...result, input });
        stepResults.push(result);
        return result;
      }
      try {
        const output = await operation();
        const result = { toolName, category, status: 'succeeded', output };
        this.store.recordAgentStep({ runId, sequence, ...result, input });
        stepResults.push(result);
        return result;
      } catch (error) {
        const detail = { message: error.message, status: error.status ?? null };
        const result = { toolName, category, status: 'failed', error: detail };
        this.store.recordAgentStep({ runId, sequence, ...result, input });
        stepResults.push(result);
        return result;
      }
    };

    try {
      for (const source of tools) {
        const shouldRun = sync && selected.has(source.name);
        const reason = !shouldRun ? 'not_selected' : !source.configured ? 'credentials_or_required_configuration_missing' : null;
        await step(`sync_${source.name}`, source.category, { source: source.name }, source.execute, reason);
      }

      requireStep(await step('rematch_receipts', 'reasoning', {}, () => ({ matched: this.service.rematchAll() })));
      const graph = await step('build_identity_graph', 'reasoning', {}, () => {
        const edges = buildIdentityGraph({
          contexts: this.store.listCustomerContexts(), identities: this.store.listIdentities(),
          externalPayments: this.store.listExternalPayments(), invoices: this.store.listInvoices()
        });
        this.store.replaceIdentityEdges(edges);
        return graphSummary(edges);
      });
      requireStep(graph);
      const coverage = sourceCoverage(stepResults);
      let investigations = [];
      requireStep(await step('investigate_exceptions', 'reasoning', { policyVersion: AGENT_POLICY_VERSION }, () => {
        investigations = investigateReconciliation({
          transfers: this.store.listTransfers(), receipts: this.store.listReceipts(),
          incidents: this.store.listIncidents('open'), invoices: this.store.listInvoices(),
          contexts: this.store.listCustomerContexts(), externalPayments: this.store.listExternalPayments(),
          sourceCoverage: coverage,
          operator: {
            queue: this.config.operatorQueue ?? 'cash_application',
            label: this.config.operatorLabel ?? 'Cash application'
          }
        });
        return { cases: investigations.length };
      }));
      let playbookApplications = 0;
      requireStep(await step('apply_playbooks', 'reasoning', {}, () => {
        const applied = applyPlaybooks(investigations, this.store.listAgentPlaybooks(true));
        investigations = applied.cases;
        playbookApplications = applied.applications;
        return { playbooks: this.store.listAgentPlaybooks(true).length, applications: playbookApplications };
      }));
      requireStep(await step('persist_case_lifecycle', 'control', {}, () => {
        this.store.reconcileAgentCases(runId, investigations);
        return { openCases: this.store.listAgentCases('open').length };
      }));

      const summary = {
        ...summarizeInvestigations(investigations, stepResults),
        identityGraph: graph.output ?? {}, sourceCoverage: coverage,
        playbookApplications,
        controls: { autonomousFinancialWrites: false, autonomousExternalMessages: false, approvalRequired: true }
      };
      this.store.finishAgentRun(runId, 'completed', summary);
      this.store.audit('agent_run_completed', 'agent_run', String(runId), 'reconciliation-agent', summary);
      return { ...this.store.getAgentRun(runId), cases: this.store.listAgentCases('open') };
    } catch (error) {
      const detail = { message: error.message, stack: error.stack };
      this.store.finishAgentRun(runId, 'failed', { financialWrites: 0 }, detail);
      this.store.audit('agent_run_failed', 'agent_run', String(runId), 'reconciliation-agent', detail);
      throw error;
    } finally {
      this.running = false;
    }
  }

  async act(caseId, { action, actor, actorPermissions = [], execute = false, note = null,
    assigneeId = null, assigneeName = null, rememberIdentity = false, verdict = null,
    expectedAllocations = [], reviewSeconds = null, baselineSeconds = null }) {
    const item = this.store.getAgentCase(caseId);
    if (!item) throw Object.assign(new Error('Agent case not found'), { status: 404 });
    if (action === 'assign') {
      requirePermission(actorPermissions, 'payments:view');
      requireActionableCase(item);
      return this.store.updateAgentCase(caseId, {
        assigneeId, assigneeName, actor, eventType: 'assigned', detail: { assigneeId, assigneeName, queue: item.assignment.queue }
      });
    }
    if (action === 'dismiss') {
      requirePermission(actorPermissions, 'payments:view');
      requireActionableCase(item);
      return this.store.updateAgentCase(caseId, {
        state: 'dismissed', actor, eventType: 'dismissed', detail: { note }
      });
    }
    if (action === 'snooze') {
      requirePermission(actorPermissions, 'payments:view');
      requireActionableCase(item);
      return this.store.updateAgentCase(caseId, {
        state: 'snoozed', actor, eventType: 'snoozed', detail: { note }
      });
    }
    if (action === 'label') {
      requirePermission(actorPermissions, 'payments:view');
      const label = this.store.recordAgentCaseLabel(caseId, {
        reviewer: actor, verdict, expectedAllocations, reviewSeconds, baselineSeconds,
        note
      });
      return { case: this.store.getAgentCase(caseId), label, financialWrite: false };
    }
    if (action === 'reject') {
      requirePermission(actorPermissions, 'payments:view');
      requireActionableCase(item);
      if (item.action.type !== 'approve_allocation') throw Object.assign(new Error('This case has no allocation proposal to reject'), { status: 409 });
      const payload = item.action.payload;
      const result = this.service.reject({
        transferId: payload.transferId, proposalId: payload.proposalId,
        actor, note: note ?? `Rejected from agent case ${caseId}`
      });
      const updated = this.store.updateAgentCase(caseId, {
        state: 'resolved', actor, eventType: 'allocation_rejected', detail: { decision: result, note }
      });
      return { case: updated, decision: result };
    }
    if (action === 'draft_remittance') {
      requirePermission(actorPermissions, 'payments:view');
      requireActionableCase(item);
      if (item.action.type !== 'request_remittance') throw Object.assign(new Error('This case has no remittance action'), { status: 409 });
      this.store.updateAgentCase(caseId, { actor, eventType: 'remittance_drafted', detail: { draft: item.action.payload } });
      return { case: this.store.getAgentCase(caseId), draft: item.action.payload, sent: false };
    }
    if (action === 'approve') {
      requirePermission(actorPermissions, 'payments:create');
      requireActionableCase(item);
      if (item.action.type !== 'approve_allocation') throw Object.assign(new Error('This case is not eligible for allocation approval'), { status: 409 });
      const payload = item.action.payload;
      const result = await this.service.approve({
        transferId: payload.transferId, proposalId: payload.proposalId,
        allocations: payload.allocations, actor, note: note ?? `Approved from agent case ${caseId}`,
        execute, rememberIdentity
      });
      const updated = this.store.updateAgentCase(caseId, {
        state: 'resolved', actor, eventType: execute ? 'allocation_executed' : 'allocation_approved',
        detail: { decision: result, execute }
      });
      return { case: updated, decision: result };
    }
    throw Object.assign(new Error(`Unsupported case action: ${action}`), { status: 400 });
  }
}

function requirePermission(actorPermissions, permission) {
  if (!actorPermissions.includes(permission)) {
    throw Object.assign(new Error(`Lago permission required: ${permission}`), { status: 403 });
  }
}

function requireActionableCase(item) {
  if (!['open', 'snoozed'].includes(item.state)) {
    throw Object.assign(new Error(`Agent case is not actionable from state: ${item.state}`), { status: 409 });
  }
}

function tool(name, category, isConfigured, execute) { return { name, category, configured: isConfigured, execute }; }

function configured(connector, ...keys) {
  if (!connector) return false;
  if (connector.agentConfigured === true) return true;
  return keys.every((key) => Boolean(connector.config?.[key]));
}

function sourceCoverage(steps) {
  return Object.fromEntries(steps.filter((item) => item.toolName.startsWith('sync_')).map((item) => [item.toolName.slice(5), item.status]));
}

function requireStep(result) {
  if (result.status === 'failed') throw Object.assign(new Error(`${result.toolName} failed: ${result.error?.message ?? 'unknown error'}`), { cause: result.error });
  return result;
}
