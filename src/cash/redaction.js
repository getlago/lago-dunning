const SENSITIVE_KEY = /(?:authorization|token|secret|password|api.?key|account.?number|routing.?number|iban|swift|bic)/i;

export function redactSensitive(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (typeof value === 'string') return redactSensitiveString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item, seen);
  }
  seen.delete(value);
  return output;
}

function redactSensitiveString(value) {
  return value
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi, '[REDACTED_IBAN]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, (candidate) => passesLuhn(candidate) ? '[REDACTED_PAN]' : candidate)
    .replace(/\b\d{9}\b/g, (candidate) => isAbaRoutingNumber(candidate) ? '[REDACTED_ABA]' : candidate);
}

function passesLuhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isAbaRoutingNumber(value) {
  const digits = [...value].map(Number);
  return digits.length === 9 && (
    3 * (digits[0] + digits[3] + digits[6]) +
    7 * (digits[1] + digits[4] + digits[7]) +
    (digits[2] + digits[5] + digits[8])
  ) % 10 === 0;
}
