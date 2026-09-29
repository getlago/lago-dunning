import { fingerprintAccount } from './signatures.js';

const DEFAULT_MAPPING = {
  id: 'id', status: 'status', direction: 'direction', amount: 'amount', currency: 'currency',
  bookedAt: 'booked_at', senderName: 'sender_name', senderAccount: 'sender_account', reference: 'reference'
};

export function parseStatementCsv(content, { sourceSystem = 'statement_csv', accountId, mapping = {}, amountUnit = 'major' } = {}) {
  const normalizedSource = String(sourceSystem ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(normalizedSource)) throw new Error('Statement sourceSystem must be a stable lowercase identifier');
  if (new Set(['mercury', 'qonto', 'brex', 'ramp', 'stripe']).has(normalizedSource)) {
    throw new Error('Statement imports cannot impersonate a live provider source');
  }
  if (!String(accountId ?? '').trim()) throw new Error('Statement accountId is required');
  if (!['major', 'minor'].includes(amountUnit)) throw new Error('Statement amountUnit must be major or minor');
  const rows = parseCsv(String(content ?? ''));
  if (rows.length < 2) throw new Error('Statement CSV must contain a header and at least one row');
  const headers = rows[0].map((value) => value.trim());
  if (new Set(headers).size !== headers.length) throw new Error('Statement CSV headers must be unique');
  const columns = { ...DEFAULT_MAPPING, ...mapping };
  for (const required of ['id', 'amount', 'currency', 'bookedAt']) {
    if (!headers.includes(columns[required])) throw new Error(`Statement CSV is missing mapped ${required} column`);
  }

  const seenSourceIds = new Set();
  return rows.slice(1).filter((row) => row.some((value) => value.trim())).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Statement CSV row ${index + 2} has ${values.length} fields; expected ${headers.length}`);
    const raw = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    const sourceId = String(raw[columns.id] ?? '').trim();
    const currency = String(raw[columns.currency] ?? '').trim().toUpperCase();
    const bookedAt = String(raw[columns.bookedAt] ?? '').trim();
    const numericAmount = Number(String(raw[columns.amount] ?? '').replaceAll(',', ''));
    if (!sourceId) throw new Error(`Statement CSV row ${index + 2} has no stable source ID`);
    if (seenSourceIds.has(sourceId)) throw new Error(`Statement CSV contains duplicate source ID: ${sourceId}`);
    seenSourceIds.add(sourceId);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Statement CSV row ${index + 2} has an invalid currency`);
    if (!bookedAt || Number.isNaN(Date.parse(bookedAt))) throw new Error(`Statement CSV row ${index + 2} has an invalid booked date`);
    if (!Number.isFinite(numericAmount) || numericAmount === 0) throw new Error(`Statement CSV row ${index + 2} has an invalid amount`);
    const decimals = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    const amountCents = amountUnit === 'minor' ? numericAmount : Math.round(numericAmount * 10 ** decimals);
    if (!Number.isInteger(amountCents)) throw new Error(`Statement CSV row ${index + 2} does not resolve to integer minor units`);
    const rawDirection = String(raw[columns.direction] ?? '').trim().toLowerCase();
    const direction = ['credit', 'incoming'].includes(rawDirection) ? 'credit'
      : ['debit', 'outgoing'].includes(rawDirection) ? 'debit' : amountCents > 0 ? 'credit' : 'debit';
    const rawStatus = String(raw[columns.status] ?? 'posted').trim().toLowerCase();
    const status = ['reversed', 'returned'].includes(rawStatus) ? 'reversed'
      : ['posted', 'completed', 'settled'].includes(rawStatus) ? 'posted' : rawStatus;
    const senderAccount = raw[columns.senderAccount];
    return {
      provider: normalizedSource, accountId: String(accountId), providerTransactionId: sourceId,
      status, direction, amountCents: Math.abs(amountCents), currency, bookedAt,
      senderName: raw[columns.senderName] || null,
      senderAccountFingerprint: fingerprintAccount(sourceSystem, senderAccount),
      reference: raw[columns.reference] || null, description: 'Imported bank statement', raw
    };
  });
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('Statement CSV contains an unterminated quoted field');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
