import { requestJson, required } from './http.js';

export function normalizeLagoInvoice(raw, payments = []) {
  const customer = raw.customer ?? {};
  const total = Number(raw.total_amount_cents ?? 0);
  const paid = Number(raw.total_paid_amount_cents ?? raw.paid_amount_cents ?? payments
    .filter((payment) => payment.payment_status === 'succeeded' || String(payment.status).toLowerCase() === 'completed')
    .reduce((sum, payment) => sum + Number(payment.amount_cents ?? 0), 0));
  const personalName = [customer.firstname, customer.lastname].filter(Boolean).join(' ');
  return {
    id: raw.lago_id,
    number: raw.number,
    customerId: raw.lago_customer_id ?? customer.lago_id ?? customer.external_id,
    customerExternalSalesforceId: customer.external_salesforce_id ?? null,
    customerName: (customer.name ?? personalName) || customer.external_id || 'Unknown customer',
    customerLegalName: customer.legal_name,
    currency: raw.currency,
    totalAmountCents: total,
    remainingAmountCents: Number(raw.remaining_amount_cents ?? Math.max(0, total - paid - Number(raw.credit_notes_amount_cents ?? 0))),
    paymentStatus: raw.payment_status,
    issuedAt: raw.issuing_date ?? raw.created_at,
    raw,
    payments
  };
}

export class LagoConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  headers() {
    required(this.config.apiKey, 'LAGO_API_KEY');
    return { authorization: `Bearer ${this.config.apiKey}` };
  }

  async listOpenInvoices() {
    return this.listInvoicesByStatus('pending');
  }

  async listInvoices() {
    return this.listInvoicesByStatus(null);
  }

  async listInvoicesByStatus(paymentStatus) {
    const output = [];
    let page = 1;
    for (;;) {
      const url = new URL(`${this.config.baseUrl}/invoices`);
      if (paymentStatus) url.searchParams.set('payment_status', paymentStatus);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const body = await this.request(url, { headers: this.headers() });
      output.push(...(body.invoices ?? []));
      if (!body.meta?.next_page) break;
      page = Number(body.meta.next_page);
    }
    return Promise.all(output.map(async (invoice) => normalizeLagoInvoice(invoice, await this.listPayments(invoice.lago_id))));
  }

  async createPayment({ invoiceId, amountCents, reference, paidAt }) {
    return this.request(`${this.config.baseUrl}/payments`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ payment: { invoice_id: invoiceId, amount_cents: amountCents, reference, paid_at: paidAt.slice(0, 10) } })
    });
  }

  async customerPortalLink(externalId) {
    if (!externalId) throw new Error('The Lago customer external ID is missing.');
    const requestedAt = Date.now();
    const body = await this.request(`${this.config.baseUrl}/customers/${encodeURIComponent(externalId)}/portal_url`, { headers: this.headers() });
    const value = body?.customer?.portal_url;
    let url;
    try { url = new URL(value); } catch { throw new Error('Lago did not return a valid billing portal link.'); }
    const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.lago.dev');
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url.hostname) && local(new URL(this.config.baseUrl).hostname))) || url.username || url.password || /[\r\n]/.test(value)) {
      throw new Error('Lago returned an unsupported billing portal link.');
    }
    // Lago's GenerateUrlService signs links for 12 hours. Allow five minutes
    // for clock skew and delivery rather than sending at the expiry boundary.
    return { url: value, expiresAt: new Date(requestedAt + (12 * 60 - 5) * 60000).toISOString() };
  }

  async listPayments(invoiceId) {
    const payments = [];
    let page = 1;
    for (;;) {
      const url = new URL(`${this.config.baseUrl}/payments`);
      url.searchParams.set('invoice_id', invoiceId);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const body = await this.request(url, { headers: this.headers() });
      payments.push(...(body.payments ?? []));
      if (!body.meta?.next_page) break;
      page = Number(body.meta.next_page);
    }
    return payments;
  }

  async findPaymentByReference(invoiceId, reference) {
    return (await this.listPayments(invoiceId)).find((payment) => payment.reference === reference) ?? null;
  }

  async getInvoice(invoiceId) {
    const body = await this.request(`${this.config.baseUrl}/invoices/${encodeURIComponent(invoiceId)}`, { headers: this.headers() });
    const raw = body.invoice ?? body;
    return normalizeLagoInvoice(raw, await this.listPayments(invoiceId));
  }
}
