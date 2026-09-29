import path from 'node:path';
import process from 'node:process';
import { isLoopback } from './local-auth.js';

export function loadConfig(overrides = {}) {
  const cwd = overrides.cwd ?? process.cwd();
  const env = { ...process.env, ...(overrides.env ?? {}) };
  const bool = (value, fallback) => value == null ? fallback : String(value).toLowerCase() === 'true';
  const dryRun = bool(env.DRY_RUN, true);
  const host = env.HOST ?? '127.0.0.1';
  const adminKeys = (env.ADMIN_KEYS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!dryRun && !adminKeys.length) throw new Error('ADMIN_KEYS is required when DRY_RUN=false');
  if (!isLoopback(host) && !adminKeys.length) throw new Error('ADMIN_KEYS is required when HOST is not loopback');
  return {
    host,
    port: Number(env.PORT ?? 4310),
    databasePath: path.resolve(cwd, env.DATABASE_PATH ?? './data/reconciliation.db'),
    dryRun,
    adminKeys,
    agent: {
      enabled: bool(env.AGENT_ENABLED, true),
      runOnStart: bool(env.AGENT_RUN_ON_START, false),
      intervalMs: Math.max(15_000, Number(env.AGENT_INTERVAL_SECONDS ?? 300) * 1000),
      sources: list(env.AGENT_SYNC_SOURCES),
      operatorQueue: env.CASH_APPLICATION_QUEUE ?? 'cash_application',
      operatorLabel: env.CASH_APPLICATION_OWNER_LABEL ?? 'Cash application'
    },
    lago: {
      baseUrl: env.LAGO_API_URL ?? 'https://api.getlago.com/api/v1',
      apiKey: env.LAGO_API_KEY ?? ''
    },
    mercury: {
      baseUrl: env.MERCURY_API_URL ?? 'https://api.mercury.com/api/v1',
      token: env.MERCURY_API_TOKEN ?? '',
      webhookSecret: env.MERCURY_WEBHOOK_SECRET ?? ''
    },
    qonto: {
      baseUrl: env.QONTO_API_URL ?? 'https://thirdparty.qonto.com/v2',
      token: env.QONTO_ACCESS_TOKEN ?? '',
      bankAccountIds: (env.QONTO_BANK_ACCOUNT_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean),
      webhookSecret: env.QONTO_WEBHOOK_SECRET ?? '',
      stagingToken: env.QONTO_STAGING_TOKEN ?? ''
    },
    brex: {
      baseUrl: env.BREX_API_URL ?? 'https://api.brex.com',
      token: env.BREX_API_TOKEN ?? '',
      cashAccountIds: list(env.BREX_CASH_ACCOUNT_IDS)
    },
    ramp: {
      baseUrl: env.RAMP_API_URL ?? 'https://api.ramp.com/developer/v1',
      token: env.RAMP_API_TOKEN ?? '',
      accountId: env.RAMP_TREASURY_ACCOUNT_ID ?? '',
      receiptsPath: env.RAMP_RECEIPTS_PATH ?? ''
    },
    stripe: {
      baseUrl: env.STRIPE_API_URL ?? 'https://api.stripe.com/v1',
      apiKey: env.STRIPE_API_KEY ?? '',
      customerMap: parseCustomerMap(env.STRIPE_CUSTOMER_MAP ?? '')
    },
    salesforce: {
      instanceUrl: env.SALESFORCE_INSTANCE_URL ?? '',
      token: env.SALESFORCE_ACCESS_TOKEN ?? '',
      apiVersion: env.SALESFORCE_API_VERSION ?? 'v67.0',
      query: env.SALESFORCE_ACCOUNT_QUERY ?? 'SELECT Id, Name, ParentId, Parent.Name, OwnerId, Owner.Name, BillingCountry FROM Account WHERE IsDeleted = false',
      lagoCustomerField: env.SALESFORCE_LAGO_CUSTOMER_FIELD ?? '',
      erpCustomerField: env.SALESFORCE_ERP_CUSTOMER_FIELD ?? '',
      aliasesField: env.SALESFORCE_PAYER_ALIASES_FIELD ?? '',
      paymentTermsField: env.SALESFORCE_PAYMENT_TERMS_FIELD ?? '',
      paymentMethodField: env.SALESFORCE_PAYMENT_METHOD_FIELD ?? '',
      billingContactEmailField: env.SALESFORCE_BILLING_CONTACT_EMAIL_FIELD ?? '',
      accountMap: parseIdMap(env.SALESFORCE_ACCOUNT_MAP ?? '', 'SALESFORCE_ACCOUNT_MAP')
    },
    erps: {
      xero: {
        baseUrl: env.XERO_API_URL ?? 'https://api.xero.com/api.xro/2.0',
        token: env.XERO_ACCESS_TOKEN ?? '',
        tenantId: env.XERO_TENANT_ID ?? ''
      },
      quickbooks: {
        baseUrl: env.QUICKBOOKS_API_URL ?? 'https://quickbooks.api.intuit.com',
        token: env.QUICKBOOKS_ACCESS_TOKEN ?? '',
        realmId: env.QUICKBOOKS_REALM_ID ?? '',
        minorVersion: Number(env.QUICKBOOKS_MINOR_VERSION ?? 75)
      },
      businessCentral: {
        baseUrl: env.BUSINESS_CENTRAL_API_URL ?? 'https://api.businesscentral.dynamics.com/v2.0',
        token: env.BUSINESS_CENTRAL_ACCESS_TOKEN ?? '',
        tenantId: env.BUSINESS_CENTRAL_TENANT_ID ?? '',
        environment: env.BUSINESS_CENTRAL_ENVIRONMENT ?? 'Production',
        companyId: env.BUSINESS_CENTRAL_COMPANY_ID ?? '',
        journalId: env.BUSINESS_CENTRAL_PAYMENT_JOURNAL_ID ?? ''
      },
      netsuite: {
        baseUrl: env.NETSUITE_API_URL ?? '',
        token: env.NETSUITE_ACCESS_TOKEN ?? '',
        accountId: env.NETSUITE_ACCOUNT_ID ?? '',
        query: env.NETSUITE_CUSTOMER_PAYMENT_QUERY ?? 'SELECT id FROM customerPayment ORDER BY id'
      },
      sap: {
        baseUrl: env.SAP_API_URL ?? '',
        token: env.SAP_ACCESS_TOKEN ?? '',
        systemId: env.SAP_SYSTEM_ID ?? '',
        apiBusinessUser: env.SAP_API_BUSINESS_USER ?? '',
        paymentPath: env.SAP_CUSTOMER_PAYMENT_PATH ?? '/api/ccpcustpayment/CustomerPayment'
      }
    }
  };
}

function list(value = '') {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseCustomerMap(value) {
  return parseIdMap(value, 'STRIPE_CUSTOMER_MAP');
}

function parseIdMap(value, label) {
  if (!value.trim()) return {};
  if (value.trim().startsWith('{')) return JSON.parse(value);
  return Object.fromEntries(value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    const sourceId = entry.slice(0, separator).trim();
    const lagoCustomerId = entry.slice(separator + 1).trim();
    if (separator < 1 || !sourceId || !lagoCustomerId) throw new Error(`${label} must contain source_id:lago_customer pairs`);
    return [sourceId, lagoCustomerId];
  }));
}
