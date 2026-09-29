import { requestJson, required } from './http.js';

// Stripe nests the payer details under a key named by bank_transfer.type
// (us_bank_transfer, eu_bank_transfer, gb_bank_transfer, ...), not on bank_transfer
// itself. Blank strings are treated as absent.
const present = (value) => (typeof value === 'string' && !value.trim() ? null : value ?? null);

export function normalizeStripeCashTransaction(raw, customerId) {
  const bankTransfer = raw.funded?.bank_transfer ?? {};
  const typed = (bankTransfer.type && bankTransfer[bankTransfer.type]) || {};
  const applied = raw.applied_to_payment ?? raw.unapplied_from_payment ?? {};
  return {
    id: raw.id,
    customerId,
    type: raw.type,
    amountCents: Number(raw.net_amount ?? raw.amount ?? 0),
    currency: String(raw.currency ?? '').toUpperCase(),
    createdAt: new Date(Number(raw.created ?? 0) * 1000).toISOString(),
    paymentIntentId: typeof applied.payment_intent === 'string' ? applied.payment_intent : applied.payment_intent?.id,
    reference: present(bankTransfer.reference) ?? present(bankTransfer.network_reference),
    senderName: present(bankTransfer.sender_name) ?? present(typed.sender_name),
    senderBank: present(bankTransfer.sender_bank_account?.bank_name) ?? present(typed.bank_name)
      ?? present(bankTransfer.bic) ?? present(typed.bic),
    raw
  };
}

export function normalizeStripePaymentIntent(raw) {
  const toIso = (value) => value == null ? null : new Date(Number(value) * 1000).toISOString();
  return {
    id: raw.id,
    customerId: typeof raw.customer === 'string' ? raw.customer : raw.customer?.id,
    status: raw.status,
    amountCents: Number(raw.amount ?? 0),
    amountReceivedCents: Number(raw.amount_received ?? 0),
    currency: String(raw.currency ?? '').toUpperCase(),
    createdAt: toIso(raw.created ?? 0),
    settledAt: raw.status === 'succeeded' ? toIso(raw.latest_charge?.created ?? raw.created ?? 0) : null,
    canceledAt: toIso(raw.canceled_at),
    invoiceId: raw.metadata?.lago_invoice_id ?? raw.metadata?.lago_payable_id ?? null,
    invoiceNumber: raw.metadata?.lago_invoice_number ?? null,
    paymentId: raw.metadata?.lago_payment_id ?? null,
    description: raw.description ?? null,
    raw
  };
}

export class StripeConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  headers() {
    required(this.config.apiKey, 'STRIPE_API_KEY');
    return { authorization: `Bearer ${this.config.apiKey}` };
  }

  async listCashBalanceTransactions(customerId) {
    return this.list(`/customers/${encodeURIComponent(customerId)}/cash_balance_transactions`, {},
      (raw) => normalizeStripeCashTransaction(raw, customerId));
  }

  async listPaymentIntents(customerId) {
    return this.list('/payment_intents', { customer: customerId }, normalizeStripePaymentIntent);
  }

  async list(path, query, normalize) {
    const output = [];
    let startingAfter;
    for (;;) {
      const url = new URL(`${this.config.baseUrl}${path}`);
      url.searchParams.set('limit', '100');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      if (startingAfter) url.searchParams.set('starting_after', startingAfter);
      const body = await this.request(url, { headers: this.headers() });
      const rows = body.data ?? [];
      output.push(...rows.map(normalize));
      if (!body.has_more || !rows.length) break;
      startingAfter = rows.at(-1).id;
    }
    return output;
  }
}
