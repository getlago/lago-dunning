import { requestJson, required } from './http.js';
import { fingerprintAccount } from './signatures.js';

function money(raw) {
  if (raw && typeof raw === 'object') {
    const divisor = Number(raw.minor_unit_conversion_rate ?? 1);
    return {
      cents: Math.round(Number(raw.amount ?? raw.value ?? 0) * (divisor === 1 ? 1 : 100 / divisor)),
      currency: raw.currency_code ?? raw.currency
    };
  }
  return { cents: Number(raw ?? 0), currency: null };
}

export function normalizeRampTreasuryTransaction(raw, accountId) {
  const amount = money(raw.amount ?? raw.total_amount);
  const directionText = String(raw.direction ?? raw.transaction_direction ?? raw.type ?? '').toUpperCase();
  const direction = /CREDIT|DEPOSIT|INCOMING|RECEIVED/.test(directionText)
    ? 'credit'
    : /DEBIT|WITHDRAWAL|OUTGOING|SENT/.test(directionText) ? 'debit' : amount.cents >= 0 ? 'credit' : 'debit';
  const counterparty = raw.counterparty ?? raw.sender ?? raw.originating_account ?? {};
  return {
    provider: 'ramp',
    accountId: accountId ?? raw.account_id ?? raw.treasury_account_id ?? 'treasury',
    providerTransactionId: String(raw.id),
    status: ['COMPLETED', 'SETTLED', 'POSTED'].includes(String(raw.status).toUpperCase()) ? 'posted' : String(raw.status ?? 'posted').toLowerCase(),
    amountCents: Math.abs(amount.cents),
    currency: String(amount.currency ?? raw.currency ?? 'USD').toUpperCase(),
    bookedAt: raw.posted_at ?? raw.settled_at ?? raw.created_at,
    senderName: counterparty.name ?? raw.description ?? raw.memo,
    senderAccountFingerprint: fingerprintAccount('ramp', counterparty.account_number ?? counterparty.accountNumber),
    reference: raw.reference_number ?? raw.reference ?? raw.memo,
    description: raw.description,
    note: raw.memo,
    direction,
    raw
  };
}

export class RampConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  async listIncoming() {
    required(this.config.token, 'RAMP_API_TOKEN');
    required(this.config.receiptsPath, 'RAMP_RECEIPTS_PATH');
    const all = [];
    let cursor;
    do {
      const url = new URL(`${this.config.baseUrl}${this.config.receiptsPath}`);
      url.searchParams.set('page_size', '100');
      if (cursor) url.searchParams.set('start', cursor);
      const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}` } });
      all.push(...(body.data ?? body.items ?? []).map((row) => normalizeRampTreasuryTransaction(row, this.config.accountId)));
      cursor = body.page?.next ?? body.next_cursor ?? null;
    } while (cursor);
    return all.filter((item) => item.direction === 'credit' && item.status === 'posted');
  }
}
