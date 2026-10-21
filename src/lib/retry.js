// Exponential backoff with full jitter, for calls to external services (payments, SMS, email).
function backoffDelay(attempt, { baseMs = 100, maxMs = 10000 } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

async function retry(fn, { retries = 3, baseMs = 100, maxMs = 10000, isRetryable = () => true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) break;
      await new Promise((r) => setTimeout(r, backoffDelay(attempt, { baseMs, maxMs })));
    }
  }
  throw lastErr;
}

module.exports = { retry, backoffDelay };
