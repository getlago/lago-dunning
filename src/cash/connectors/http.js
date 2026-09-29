export async function requestJson(url, options = {}) {
  const { timeoutMs = 15_000, ...fetchOptions } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = fetchOptions.signal ? AbortSignal.any([fetchOptions.signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetch(url, {
      ...fetchOptions, signal,
      headers: { accept: 'application/json', ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}), ...fetchOptions.headers }
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw Object.assign(new Error(`Provider request timed out after ${timeoutMs}ms`), { status: 504 });
    throw error;
  }
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
