import { requestJson, required } from './http.js';

export function normalizeSalesforceAccount(raw, config = {}) {
  const field = (name) => name ? raw[name] : null;
  const aliases = String(field(config.aliasesField) ?? '').split(/[;,|]/).map((value) => value.trim()).filter(Boolean);
  return {
    source: 'salesforce',
    crmAccountId: String(raw.Id),
    lagoCustomerId: field(config.lagoCustomerField) ?? config.accountMap?.[raw.Id] ?? null,
    erpCustomerId: field(config.erpCustomerField) ?? null,
    accountName: raw.Name,
    parentCrmAccountId: raw.ParentId ?? raw.Parent?.Id ?? null,
    parentName: raw.Parent?.Name ?? null,
    ownerId: raw.OwnerId ?? raw.Owner?.Id ?? null,
    ownerName: raw.Owner?.Name ?? null,
    billingCountry: raw.BillingCountry ?? null,
    aliases,
    paymentTermsDays: Number(field(config.paymentTermsField)) || null,
    expectedPaymentMethod: field(config.paymentMethodField) ?? null,
    billingContactEmail: field(config.billingContactEmailField) ?? null,
    raw
  };
}

export class SalesforceConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  async listAccountContexts() {
    required(this.config.token, 'SALESFORCE_ACCESS_TOKEN');
    required(this.config.instanceUrl, 'SALESFORCE_INSTANCE_URL');
    required(this.config.query, 'SALESFORCE_ACCOUNT_QUERY');
    let url = new URL(`${this.config.instanceUrl}/services/data/${this.config.apiVersion}/query`);
    url.searchParams.set('q', this.config.query);
    const records = [];
    for (;;) {
      const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}` } });
      records.push(...(body.records ?? []));
      if (body.done || !body.nextRecordsUrl) break;
      url = new URL(body.nextRecordsUrl, this.config.instanceUrl);
    }
    return records.map((row) => normalizeSalesforceAccount(row, this.config));
  }
}
