import { requestJson, required } from './http.js';
import { fingerprintAccount } from './signatures.js';

function cents(value) {
  if (value && typeof value === 'object') return Number(value.amount ?? value.value ?? 0);
  return Number(value ?? 0);
}
export function normalizeBrexCashTransaction(raw, accountId) {
  const amountCents = cents(raw.amount);
  const directionText = String(raw.direction ?? raw.transaction_direction ?? raw.type ?? '').toUpperCase();
  const direction = /CREDIT|DEPOSIT|INCOMING|RECEIVED/.test(directionText)
    ? 'credit'
    : /DEBIT|WITHDRAWAL|OUTGOING|SENT/.test(directionText) ? 'debit' : amountCents >= 0 ? 'credit' : 'debit';
  const counterparty = raw.counterparty ?? raw.originating_account ?? raw.sender ?? {};
  const accountNumber = counterparty.account_number ?? counterparty.accountNumber ?? raw.originating_account_number;
  return {
    provider: 'brex',
    accountId: accountId ?? raw.cash_account_id ?? raw.account_id ?? 'primary',
    providerTransactionId: String(raw.id),
    status: raw.status === 'SETTLED' ? 'posted' : String(raw.status ?? 'posted').toLowerCase(),
    amountCents: Math.abs(amountCents),
    currency: String(raw.amount?.currency ?? raw.currency ?? 'USD').toUpperCase(),
    bookedAt: raw.posted_at ?? raw.settled_at ?? raw.created_at,
    senderName: counterparty.name ?? raw.description ?? raw.memo,
    senderAccountFingerprint: fingerprintAccount('brex', accountNumber),
    reference: raw.reference_number ?? raw.reference ?? raw.memo,
    description: raw.description,
    note: raw.memo,
    direction,
    raw
  };
}

export class BrexConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  async listIncoming() {
    required(this.config.token, 'BREX_API_TOKEN');
    const accountIds = this.config.cashAccountIds.length ? this.config.cashAccountIds : await this.listCashAccountIds();
    const all = [];
    for (const accountId of accountIds) {
      let cursor;
      do {
        const url = new URL(`${this.config.baseUrl}/v2/transactions/cash/${encodeURIComponent(accountId)}`);
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('cursor', cursor);
        const body = await this.request(url, { headers: this.headers() });
        all.push(...(body.items ?? body.data ?? []).map((row) => normalizeBrexCashTransaction(row, accountId)));
        cursor = body.next_cursor ?? body.page?.next ?? null;
      } while (cursor);
    }
    return all.filter((item) => item.direction === 'credit' && item.status === 'posted');
  }

  async listCashAccountIds() {
    const body = await this.request(`${this.config.baseUrl}/v2/accounts/cash`, { headers: this.headers() });
    return (body.items ?? body.data ?? []).filter((row) => row.status === 'ACTIVE' || !row.status).map((row) => row.id);
  }

  headers() { return { authorization: `Bearer ${this.config.token}` }; }
}
