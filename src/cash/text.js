const companyNoise = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'sas', 'sa', 'gmbh', 'ag', 'plc',
  'corp', 'corporation', 'company', 'co', 'bv', 'oy', 'ab', 'pte', 'pty', 'holdings'
]);

export function foldText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function compact(value = '') {
  return foldText(value).replace(/\s/g, '');
}

export function normalizeCompany(value = '') {
  return foldText(value)
    .toLowerCase()
    .split(' ')
    .filter((token) => token.length > 1 && !companyNoise.has(token))
    .join(' ');
}

export function tokens(value = '') {
  return new Set(foldText(value).split(' ').filter((token) => token.length > 1));
}

export function tokenSimilarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

export function levenshtein(a, b) {
  const left = compact(a);
  const right = compact(b);
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[right.length];
}

export function stringSimilarity(a, b) {
  const left = compact(a);
  const right = compact(b);
  if (!left.length || !right.length) return 0;
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length);
}

export function referenceEvidence(referenceText, invoiceNumber) {
  const reference = compact(referenceText);
  const invoice = compact(invoiceNumber);
  if (!reference || !invoice) return { kind: 'missing', score: 0, similarity: 0 };
  if (reference === invoice) return { kind: 'exact', score: 70, similarity: 1 };
  // Match the complete letter/number sequence with hard alphanumeric
  // boundaries. Delimiter changes remain valid (INV12 vs INV-12), while a
  // longer identifier (INV-123) cannot authorize a shorter one (INV-12).
  const normalizedReference = String(referenceText).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const chunks = String(invoiceNumber).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().match(/[A-Z]+|\d+/g) ?? [];
  const pattern = chunks.map(escapeRegex).join('[^A-Z0-9]*');
  const containsCompleteReference = pattern && new RegExp(`(^|[^A-Z0-9])${pattern}(?![A-Z0-9])`).test(normalizedReference);
  if (containsCompleteReference) return { kind: 'contained', score: 62, similarity: 1 };

  const candidates = foldText(referenceText).split(' ').filter((token) => token.length >= 5);
  const similarity = Math.max(stringSimilarity(reference, invoice), ...candidates.map((token) => stringSimilarity(token, invoice)));
  if (invoice.length >= 6 && similarity >= 0.92) return { kind: 'near_exact', score: 42, similarity };
  if (invoice.length >= 6 && similarity >= 0.8) return { kind: 'fuzzy', score: 18, similarity };
  return { kind: 'mismatch', score: -8, similarity };
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
