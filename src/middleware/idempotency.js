const { sha256 } = require('../lib/crypto');
const { badRequest, conflict } = require('../lib/errors');

// Idempotency for write endpoints (Stripe-style).
// - Client sends `Idempotency-Key` header (required).
// - First request: key is reserved, handler runs, response is stored.
// - Retry with same key + same body: stored response is replayed (no double booking/charge).
// - Same key + different body: 422. Same key while first is still running: 409.
function idempotency(db) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 255) return next(badRequest('Idempotency-Key header is required (max 255 chars)'));

    const userId = req.user.id;
    const hash = sha256(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body || {})}`);

    try {
      const inserted = await db.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING key`,
        [userId, key, hash]
      );

      if (inserted.rowCount === 0) {
        const { rows } = await db.query(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
          [userId, key]
        );
        const existing = rows[0];
        if (existing.request_hash !== hash) {
          return res.status(422).json({ error: { code: 'IDEMPOTENCY_MISMATCH', message: 'Key reused with a different request' } });
        }
        if (existing.response_status == null) return next(conflict('Request with this Idempotency-Key is in progress'));
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.response_status).json(existing.response_body);
      }

      // Capture the response so retries get the same answer.
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const store = res.statusCode < 500
          ? db.query(
              'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2',
              [userId, key, res.statusCode, body]
            )
          : // Server errors are not cached: release the key so the client can retry.
            db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
        store.catch(() => {}).finally(() => originalJson(body));
        return res;
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { idempotency };
