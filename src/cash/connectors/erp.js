import { requestJson, required } from './http.js';

const toCents = (value) => Math.round(Number(value ?? 0) * 100);

function isoFromXero(value) {
  if (!value) return null;
  const match = String(value).match(/\/Date\((\d+)/);
  return match ? new Date(Number(match[1])).toISOString() : value;
}

function origin(raw) {
  const explicit = raw.origin_system ?? raw.originSystem ?? raw.integration_source ?? raw.integrationSource;
  return explicit ? String(explicit).toLowerCase() : null;
}

export function normalizeXeroPayment(raw, tenantId) {
  const invoice = raw.Invoice ?? {};
  const reference = raw.Reference ?? null;
  return {
    provider: 'xero',
    organizationId: tenantId,
    providerPaymentId: String(raw.PaymentID),
    status: String(raw.Status ?? '').toLowerCase(),
    amountCents: toCents(raw.Amount ?? raw.BankAmount),
    unappliedAmountCents: 0,
    currency: String(invoice.CurrencyCode ?? raw.CurrencyCode ?? '').toUpperCase(),
    paidAt: isoFromXero(raw.Date ?? raw.UpdatedDateUTCString ?? raw.UpdatedDateUTC),
    customerId: invoice.Contact?.ContactID ?? null,
    customerName: invoice.Contact?.Name ?? null,
    reference,
    originSystem: origin(raw),
    allocations: invoice.InvoiceID ? [{
      externalInvoiceId: invoice.InvoiceID,
      invoiceNumber: invoice.InvoiceNumber ?? null,
      amountCents: toCents(raw.Amount ?? raw.BankAmount)
    }] : [],
    raw
  };
}

export function normalizeQuickBooksPayment(raw, realmId) {
  const reference = raw.PaymentRefNum ?? raw.PrivateNote ?? null;
  const allocations = (raw.Line ?? []).flatMap((line) => (line.LinkedTxn ?? [])
    .filter((link) => String(link.TxnType).toLowerCase() === 'invoice')
    .map((link) => ({ externalInvoiceId: link.TxnId, invoiceNumber: null, amountCents: toCents(line.Amount) })));
  return {
    provider: 'quickbooks',
    organizationId: realmId,
    providerPaymentId: String(raw.Id),
    status: raw.Voided ? 'voided' : 'posted',
    amountCents: toCents(raw.TotalAmt),
    unappliedAmountCents: toCents(raw.UnappliedAmt),
    currency: String(raw.CurrencyRef?.value ?? raw.CurrencyRef ?? '').toUpperCase(),
    paidAt: raw.TxnDate ?? raw.MetaData?.CreateTime,
    customerId: raw.CustomerRef?.value ?? null,
    customerName: raw.CustomerRef?.name ?? null,
    reference,
    originSystem: origin(raw),
    allocations,
    raw
  };
}

export function normalizeBusinessCentralPayment(raw, companyId) {
  const reference = raw.externalDocumentNumber ?? raw.documentNumber ?? null;
  return {
    provider: 'business_central',
    organizationId: companyId,
    providerPaymentId: String(raw.id),
    status: raw.status ? String(raw.status).toLowerCase() : 'posted',
    amountCents: Math.abs(toCents(raw.amount)),
    unappliedAmountCents: raw.appliesToInvoiceId ? 0 : Math.abs(toCents(raw.amount)),
    currency: String(raw.currencyCode ?? raw.currency ?? '').toUpperCase(),
    paidAt: raw.postingDate ?? raw.lastModifiedDateTime,
    customerId: raw.customerId ?? raw.customerNumber ?? null,
    customerName: raw.customerName ?? null,
    reference,
    originSystem: origin(raw),
    allocations: raw.appliesToInvoiceId || raw.appliesToInvoiceNumber ? [{
      externalInvoiceId: raw.appliesToInvoiceId ?? null,
      invoiceNumber: raw.appliesToInvoiceNumber ?? null,
      amountCents: Math.abs(toCents(raw.amount))
    }] : [],
    raw
  };
}

export function normalizeNetSuitePayment(raw, accountId) {
  const reference = raw.memo ?? raw.externalId ?? raw.tranId ?? null;
  const applied = raw.apply?.items ?? raw.apply?.item ?? raw.appliedInvoices ?? [];
  const allocations = applied.filter((item) => item.apply !== false).map((item) => ({
    externalInvoiceId: String(item.doc?.id ?? item.doc ?? item.invoice?.id ?? item.invoiceId ?? ''),
    invoiceNumber: item.doc?.refName ?? item.invoice?.refName ?? item.invoiceNumber ?? null,
    amountCents: toCents(item.amount ?? item.paymentAmount)
  })).filter((item) => item.externalInvoiceId || item.invoiceNumber);
  const amountCents = toCents(raw.payment ?? raw.total ?? raw.amount);
  const allocatedAmountCents = allocations.reduce((sum, item) => sum + item.amountCents, 0);
  return {
    provider: 'netsuite',
    organizationId: accountId,
    providerPaymentId: String(raw.id ?? raw.internalId),
    status: raw.voided ? 'voided' : 'posted',
    amountCents,
    unappliedAmountCents: Math.max(0, amountCents - allocatedAmountCents),
    currency: String(raw.currency?.refName ?? raw.currency?.id ?? raw.currency ?? '').toUpperCase(),
    paidAt: raw.tranDate ?? raw.dateCreated ?? raw.lastModifiedDate,
    customerId: raw.customer?.id ?? raw.entity?.id ?? null,
    customerName: raw.customer?.refName ?? raw.entity?.refName ?? null,
    reference,
    originSystem: origin(raw),
    allocations,
    raw
  };
}

export function normalizeSapPayment(raw, systemId) {
  const reference = raw.PaymentReference ?? raw.ReferenceDocument ?? raw.ExternalReference ?? null;
  const items = raw.CustomerPaymentItem ?? raw.to_CustomerPaymentItem?.results ?? raw.items ?? [];
  const allocations = items.map((item) => ({
    externalInvoiceId: String(item.AccountingDocument ?? item.InvoiceReference ?? item.InvoiceId ?? ''),
    invoiceNumber: item.InvoiceNumber ?? item.ReferenceDocument ?? null,
    amountCents: Math.abs(toCents(item.PaymentAmount ?? item.AmountInTransactionCurrency ?? item.Amount))
  })).filter((item) => item.externalInvoiceId || item.invoiceNumber);
  const amountCents = Math.abs(toCents(raw.PaymentAmount ?? raw.AmountInTransactionCurrency ?? raw.Amount));
  const allocatedAmountCents = allocations.reduce((sum, item) => sum + item.amountCents, 0);
  return {
    provider: 'sap',
    organizationId: systemId,
    providerPaymentId: String(raw.CustomerPaymentUUID ?? raw.CustomerPayment ?? raw.PaymentDocument ?? raw.id),
    status: raw.IsReversed || raw.ReversalDocument ? 'voided' : 'posted',
    amountCents,
    unappliedAmountCents: Math.max(0, amountCents - allocatedAmountCents),
    currency: String(raw.TransactionCurrency ?? raw.Currency ?? '').toUpperCase(),
    paidAt: raw.PaymentDate ?? raw.PostingDate ?? raw.CreationDateTime,
    customerId: raw.Customer ?? raw.CustomerNumber ?? null,
    customerName: raw.CustomerName ?? null,
    reference,
    originSystem: origin(raw),
    allocations,
    raw
  };
}

export class XeroConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }
  async listCustomerPayments() {
    required(this.config.token, 'XERO_ACCESS_TOKEN');
    required(this.config.tenantId, 'XERO_TENANT_ID');
    const url = new URL(`${this.config.baseUrl}/Payments`);
    url.searchParams.set('where', 'PaymentType=="ACCRECPAYMENT" AND Status=="AUTHORISED"');
    const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}`, 'xero-tenant-id': this.config.tenantId } });
    return (body.Payments ?? []).map((row) => normalizeXeroPayment(row, this.config.tenantId));
  }
}

export class QuickBooksConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }
  async listCustomerPayments() {
    required(this.config.token, 'QUICKBOOKS_ACCESS_TOKEN');
    required(this.config.realmId, 'QUICKBOOKS_REALM_ID');
    const url = new URL(`${this.config.baseUrl}/v3/company/${encodeURIComponent(this.config.realmId)}/query`);
    url.searchParams.set('query', 'select * from Payment');
    url.searchParams.set('minorversion', String(this.config.minorVersion));
    const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}` } });
    return (body.QueryResponse?.Payment ?? []).map((row) => normalizeQuickBooksPayment(row, this.config.realmId));
  }
}

export class BusinessCentralConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }
  async listCustomerPayments() {
    required(this.config.token, 'BUSINESS_CENTRAL_ACCESS_TOKEN');
    required(this.config.companyId, 'BUSINESS_CENTRAL_COMPANY_ID');
    required(this.config.journalId, 'BUSINESS_CENTRAL_PAYMENT_JOURNAL_ID');
    const url = `${this.config.baseUrl}/${encodeURIComponent(this.config.tenantId)}/${encodeURIComponent(this.config.environment)}`
      + `/api/v2.0/companies(${encodeURIComponent(this.config.companyId)})/customerPaymentJournals(${encodeURIComponent(this.config.journalId)})/customerPayments`;
    const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}` } });
    return (body.value ?? []).map((row) => normalizeBusinessCentralPayment(row, this.config.companyId));
  }
}

export class NetSuiteConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }
  async listCustomerPayments() {
    required(this.config.token, 'NETSUITE_ACCESS_TOKEN');
    required(this.config.accountId, 'NETSUITE_ACCOUNT_ID');
    const summaries = [];
    let offset = 0;
    for (;;) {
      const url = new URL(`${this.config.baseUrl}/services/rest/query/v1/suiteql`);
      url.searchParams.set('limit', '1000');
      url.searchParams.set('offset', String(offset));
      const body = await this.request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.token}`, prefer: 'transient' },
        body: JSON.stringify({ q: this.config.query })
      });
      summaries.push(...(body.items ?? []));
      if (!body.hasMore) break;
      offset += Number(body.count ?? 1000);
    }
    const rows = [];
    for (const summary of summaries) {
      const id = summary.id ?? summary.internalId;
      const record = await this.request(`${this.config.baseUrl}/services/rest/record/v1/customerpayment/${encodeURIComponent(id)}?expandSubResources=true`, {
        headers: { authorization: `Bearer ${this.config.token}` }
      });
      rows.push(normalizeNetSuitePayment(record, this.config.accountId));
    }
    return rows;
  }
}

export class SapConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }
  async listCustomerPayments() {
    required(this.config.token, 'SAP_ACCESS_TOKEN');
    required(this.config.systemId, 'SAP_SYSTEM_ID');
    const url = `${this.config.baseUrl}${this.config.paymentPath}`;
    const headers = { authorization: `Bearer ${this.config.token}` };
    if (this.config.apiBusinessUser) headers.ApiBusinessUser = this.config.apiBusinessUser;
    const body = await this.request(url, { headers });
    return (body.value ?? body.d?.results ?? []).map((row) => normalizeSapPayment(row, this.config.systemId));
  }
}
