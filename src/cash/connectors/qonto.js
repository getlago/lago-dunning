import { requestJson, required } from './http.js';
import { fingerprintAccount, verifyTimestampedHmac } from './signatures.js';

// Qonto nests counterparty details in a sub-object named after the operation:
// `income` and `swift_income` for incoming credits, `transfer` for outgoing. Reading
// only `transfer` leaves every credit with no payer and no account fingerprint.
const COUNTERPARTY_BLOCKS = ['income', 'swift_income', 'transfer', 'direct_debit', 'direct_debit_collection'];

function counterparty(raw) {
  for (const key of COUNTERPARTY_BLOCKS) {
    const block = raw[key];
    if (block && typeof block === 'object') return block;
  }
  return {};
}

export function normalizeQontoTransaction(raw, accountId = raw.bank_account_id) {
  const party = counterparty(raw);
  const accountNumber = party.counterparty_account_number ?? party.counterparty_iban ?? party.iban;
  // For a genuine incoming SEPA credit Qonto puts the debtor name in `label` — verified
  // against a real SCT IN transaction in the Sandbox, where label was "RIVAGE ANALYTICS
  // SAS". Auto-seeded sandbox rows instead carry an operation word there ("TOPUP"), so it
  // ranks last, but dropping it altogether loses the payer on every real payment.
  const senderName = raw.clean_counterparty_name ?? party.counterparty_name ?? party.name
    ?? raw.label ?? null;
  return {
    provider: 'qonto',
    accountId: accountId ?? 'organization',
    providerTransactionId: String(raw.id ?? raw.transaction_id),
    status: raw.status === 'completed' ? 'posted' : raw.status === 'reversed' ? 'reversed' : raw.status,
    amountCents: Number(raw.amount_cents ?? Math.round(Number(raw.amount) * 100)),
    currency: String(raw.currency).toUpperCase(),
    bookedAt: raw.settled_at ?? raw.emitted_at ?? raw.updated_at,
    senderName,
    senderBank: party.counterparty_bank_identifier ?? party.counterparty_bic ?? null,
    senderAccountFingerprint: fingerprintAccount('qonto', accountNumber),
    reference: raw.reference,
    description: raw.label,
    note: raw.note,
    direction: raw.side,
    raw
  };
}

export class QontoConnector {
  constructor(config, request = requestJson) { this.config = config; this.request = request; }

  // Qonto's Sandbox rejects requests without this header; production ignores it.
  headers() {
    if (this.config.oauth) return {}; // OAuth request adapter adds server-side credentials.
    required(this.config.token, 'QONTO_ACCESS_TOKEN');
    return {
      authorization: `Bearer ${this.config.token}`,
      ...(this.config.stagingToken ? { 'x-qonto-staging-token': this.config.stagingToken } : {})
    };
  }

  // /v2/transactions rejects any request without bank_account_id or iban, so an
  // unconfigured QONTO_BANK_ACCOUNT_IDS cannot mean "all accounts" the way it does for
  // Mercury or Brex. Discover them instead of failing every sync with a 400.
  async listBankAccountIds() {
    const ids = [];
    let page = 1;
    for (;;) {
      const url = new URL(`${this.config.baseUrl}/bank_accounts`);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const body = await this.request(url, { headers: this.headers() });
      for (const account of body.bank_accounts ?? []) {
        if (account.status && account.status !== 'active') continue;
        if (account.id) ids.push(account.id);
      }
      if (!body.meta?.next_page) break;
      page = Number(body.meta.next_page);
    }
    return ids;
  }

  async listIncoming({ updatedAtFrom } = {}) {
    if (!this.config.oauth) required(this.config.token, 'QONTO_ACCESS_TOKEN');
    const accountIds = this.config.oauth ? this.config.oauth.selectedAccounts() : this.config.bankAccountIds.length
      ? this.config.bankAccountIds
      : await this.listBankAccountIds();
    if (!accountIds.length) {
      throw new Error('No active Qonto bank account is readable; set QONTO_BANK_ACCOUNT_IDS or check the token scope');
    }
    const all = [];
    for (const accountId of accountIds) {
      let page = 1;
      for (;;) {
        const url = new URL(`${this.config.baseUrl}/transactions`);
        url.searchParams.set('bank_account_id', accountId);
        url.searchParams.set('side', 'credit');
        url.searchParams.append('status[]', 'completed');
        url.searchParams.set('sort_by', 'updated_at:asc');
        url.searchParams.set('per_page', '100');
        url.searchParams.set('page', String(page));
        if (updatedAtFrom) url.searchParams.set('updated_at_from', updatedAtFrom);
        const body = await this.request(url, { headers: this.headers() });
        all.push(...(body.transactions ?? []).map((raw) => normalizeQontoTransaction(raw, accountId)));
        if (!body.meta?.next_page) break;
        page = Number(body.meta.next_page);
      }
    }
    return all;
  }

  async getTransaction(id) {
    if (!this.config.oauth) required(this.config.token, 'QONTO_ACCESS_TOKEN');
    const body = await this.request(`${this.config.baseUrl}/transactions/${encodeURIComponent(id)}`, {
      headers: this.headers()
    });
    return normalizeQontoTransaction(body.transaction ?? body);
  }

  verifyWebhook(rawBody, header) {
    return verifyTimestampedHmac(rawBody, header, this.config.webhookSecret);
  }
}
