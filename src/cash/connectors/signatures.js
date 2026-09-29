import crypto from 'node:crypto';

function safeEqual(left, right) {
  const a = Buffer.from(left ?? '', 'utf8');
  const b = Buffer.from(right ?? '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyTimestampedHmac(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2)));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1 || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return safeEqual(parts.v1, expected);
}

export function fingerprintAccount(provider, accountNumber) {
  if (!accountNumber) return null;
  return crypto.createHash('sha256').update(`${provider}:${String(accountNumber).replace(/\s/g, '').toUpperCase()}`).digest('hex');
}
