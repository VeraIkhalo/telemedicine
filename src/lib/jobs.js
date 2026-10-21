// Enqueue a background job inside the caller's transaction (transactional outbox):
// the job exists if and only if the business change committed.
async function enqueue(db, type, payload, { delayMs = 0, maxAttempts = 5 } = {}) {
  await db.query(
    `INSERT INTO jobs (type, payload, run_at, max_attempts)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4)`,
    [type, payload, String(delayMs), maxAttempts]
  );
}

module.exports = { enqueue };
