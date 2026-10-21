const { createCipher } = require('../src/lib/crypto');
const { canTransition } = require('../src/lib/stateMachine');
const { createCache } = require('../src/lib/cache');
const { retry, backoffDelay } = require('../src/lib/retry');
const { authorize, signToken, authenticate } = require('../src/middleware/auth');

const key = (n) => Buffer.alloc(32, n).toString('base64');

describe('field encryption', () => {
  test('round-trips and uses random IVs', () => {
    const c = createCipher(`v1:${key(1)}`);
    const a = c.encrypt('patient notes');
    expect(a).not.toContain('patient notes');
    expect(c.encrypt('patient notes')).not.toEqual(a);
    expect(c.decrypt(a)).toBe('patient notes');
  });

  test('key rotation: old ciphertext still decrypts, new writes use new key', () => {
    const old = createCipher(`v1:${key(1)}`);
    const ct = old.encrypt('secret');
    const rotated = createCipher(`v2:${key(2)},v1:${key(1)}`);
    expect(rotated.decrypt(ct)).toBe('secret');
    expect(rotated.needsRotation(ct)).toBe(true);
    expect(rotated.encrypt('x').startsWith('v2:')).toBe(true);
  });

  test('tampered ciphertext is rejected', () => {
    const c = createCipher(`v1:${key(1)}`);
    const parts = c.encrypt('hello').split(':');
    parts[3] = Buffer.from('evil').toString('base64');
    expect(() => c.decrypt(parts.join(':'))).toThrow();
  });
});

describe('consultation state machine', () => {
  test.each([
    ['scheduled', 'in_progress', 'doctor', true],
    ['scheduled', 'in_progress', 'patient', false],
    ['in_progress', 'completed', 'doctor', true],
    ['completed', 'cancelled', 'admin', false],
    ['scheduled', 'cancelled', 'patient', true],
    ['pending_payment', 'scheduled', 'patient', false],
  ])('%s -> %s as %s = %s', (from, to, role, ok) => {
    expect(canTransition(from, to, role)).toBe(ok);
  });
});

describe('cache', () => {
  test('expires entries and invalidates by prefix', async () => {
    const cache = createCache({ ttlMs: 20 });
    cache.set('doctors:a', 1);
    cache.set('other', 2);
    expect(cache.get('doctors:a')).toBe(1);
    cache.delByPrefix('doctors:');
    expect(cache.get('doctors:a')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get('other')).toBeUndefined();
  });
});

describe('retry with backoff', () => {
  test('retries transient errors then succeeds', async () => {
    let calls = 0;
    const out = await retry(async () => { if (++calls < 3) throw new Error('flaky'); return 'ok'; }, { baseMs: 1 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error('fatal'); }, { baseMs: 1, isRetryable: () => false })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  test('backoff is capped', () => {
    for (let i = 0; i < 20; i++) expect(backoffDelay(i, { baseMs: 100, maxMs: 1000 })).toBeLessThan(1000);
  });
});

describe('RBAC middleware', () => {
  const run = (mw, req) => new Promise((resolve) => mw(req, {}, resolve));

  test('authorize rejects wrong role with 403', async () => {
    const err = await run(authorize('admin'), { user: { id: '1', role: 'patient' } });
    expect(err.status).toBe(403);
  });

  test('authenticate accepts valid token and rejects tampered token', async () => {
    const token = signToken({ id: 'u1', role: 'doctor' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    expect(await run(authenticate, req)).toBeUndefined();
    expect(req.user).toEqual({ id: 'u1', role: 'doctor' });
    const bad = await run(authenticate, { headers: { authorization: `Bearer ${token}x` } });
    expect(bad.status).toBe(401);
  });
});
