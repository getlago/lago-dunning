import crypto from 'node:crypto';

const PERMISSIONS = Object.freeze(['payments:view', 'payments:create']);

export function isLoopback(value = '') {
  const address = String(value).toLowerCase().replace(/^\[|\]$/g, '');
  return address === 'localhost' || address === '::1' || address === '0:0:0:0:0:0:0:1' ||
    address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function authorizeLocalRequest(request, config) {
  const provided = String(request.headers?.['x-admin-key'] ?? '');
  const matched = provided && config.adminKeys.some((candidate) => safeKeyEqual(provided, candidate));
  if (matched) {
    return {
      actor: `local-admin:${fingerprint(provided)}`,
      permissions: [...PERMISSIONS],
      authenticatedBy: 'admin_key',
      isAdmin: true
    };
  }
  if (config.adminKeys.length) throw httpError(401, 'A valid x-admin-key is required');
  const forwarded = request.headers?.forwarded || request.headers?.['x-forwarded-for'];
  const requestHost = hostname(request.headers?.host);
  if (!config.dryRun || forwarded || !isLoopback(request.socket?.remoteAddress) || !isLoopback(requestHost)) {
    throw httpError(403, 'The unauthenticated demo API is restricted to loopback in dry-run mode');
  }
  return {
    actor: 'local-demo-user',
    permissions: [...PERMISSIONS],
    authenticatedBy: 'loopback_dry_run',
    isAdmin: true
  };
}

export function requirePermission(principal, permission) {
  if (!principal?.permissions.includes(permission)) throw httpError(403, `Lago permission required: ${permission}`);
}

export function requireLiveAdmin(principal, config) {
  if (config.dryRun) return;
  if (!principal?.isAdmin || principal.authenticatedBy !== 'admin_key') {
    throw httpError(403, 'A valid x-admin-key is required for live writes');
  }
}

function safeKeyEqual(left, right) {
  const a = crypto.createHash('sha256').update(left).digest();
  const b = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function hostname(value = '') {
  try { return new URL(`http://${value}`).hostname; } catch { return ''; }
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
