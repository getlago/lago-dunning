import { requestJson, required } from './http.js';
import { fingerprintAccount, verifyTimestampedHmac } from './signatures.js';

// Mercury exposes the counterparty account number only inside the method-specific
// routing block of `details`, never at the top level. Older shapes nested it under
// `counterparty`, so both are accepted.
function counterpartyAccountNumber(raw) {
  const counterparty = raw.counterparty ?? raw.counterpartyDetails ?? {};
  const details = raw.details ?? {};
  return counterparty.accountNumber ?? counterparty.account_number ?? raw.originatingAccountNumber
    ?? details.electronicRoutingInfo?.accountNumber
    ?? details.domesticWireRoutingInfo?.accountNumber
    ?? details.internationalWireRoutingInfo?.accountNumber
    ?? details.internationalWireRoutingInfo?.iban
    ?? null;
}

export function normalizeMercuryTransaction(raw) {
  const amount = typeof raw.amount === 'number' ? raw.amount : Number(raw.amount?.amount ?? raw.amount?.value ?? 0);
  const currency = raw.currency ?? raw.amount?.currency ?? 'USD';
  const counterparty = raw.counterparty ?? raw.counterpartyDetails ?? {};
  const accountNumber = counterpartyAccountNumber(raw);
  return {
    provider: 'mercury',
    accountId: raw.accountId ?? raw.account_id ?? 'organization',
    providerTransactionId: String(raw.id),
    status: raw.status === 'sent' && raw.postedAt ? 'posted' : raw.status,
    amountCents: Math.round(Math.abs(amount) * 100),
    currency: String(currency).toUpperCase(),
    bookedAt: raw.postedAt ?? raw.createdAt ?? raw.updatedAt,
    senderName: counterparty.name ?? raw.counterpartyName ?? raw.senderName ?? raw.bankDescription,
    senderAccountFingerprint: fingerprintAccount('mercury', accountNumber),
    reference: raw.externalMemo ?? raw.reference ?? raw.bankDescription,
    description: raw.bankDescription ?? raw.description,
    note: raw.note,
    direction: raw.direction ?? (amount > 0 ? 'credit' : 'debit'),
    raw
  };
}

export class MercuryConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  async listIncoming({ postedStart, postedEnd } = {}) {
    required(this.config.token, 'MERCURY_API_TOKEN');
    const output = [];
    let startAfter = null;
    const seenCursors = new Set();
    for (;;) {
      const url = new URL(`${this.config.baseUrl}/transactions`);
      url.searchParams.set('order', 'asc');
      url.searchParams.set('limit', '1000');
      if (postedStart) url.searchParams.set('postedStart', postedStart);
      if (postedEnd) url.searchParams.set('postedEnd', postedEnd);
      if (startAfter) url.searchParams.set('start_after', startAfter);
      const body = await this.request(url, { headers: { authorization: `Bearer ${this.config.token}` } });
      const rows = body?.transactions ?? body?.items ?? body ?? [];
      output.push(...rows);
      if (rows.length < 1000) break;
      const next = String(rows.at(-1)?.id ?? '');
      if (!next || seenCursors.has(next)) throw new Error('Mercury pagination did not advance');
      seenCursors.add(next);
      startAfter = next;
    }
    return output.map(normalizeMercuryTransaction)
      .filter((item) => item.direction === 'credit' && ['posted', 'reversed'].includes(item.status));
  }

  async getTransaction(id) {
    required(this.config.token, 'MERCURY_API_TOKEN');
    const raw = await this.request(`${this.config.baseUrl}/transaction/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.config.token}` }
    });
    return normalizeMercuryTransaction(raw.transaction ?? raw);
  }

  verifyWebhook(rawBody, header) {
    return verifyTimestampedHmac(rawBody, header, this.config.webhookSecret);
  }
}
