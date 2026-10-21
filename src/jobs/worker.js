// Background worker. Polls the jobs table with FOR UPDATE SKIP LOCKED so many workers
// can run in parallel without picking the same job. Failed jobs retry with exponential
// backoff + jitter; after max_attempts they move to 'dead' (dead-letter) for inspection.
const { createDb } = require('../db');
const { createHandlers } = require('./handlers');
const { backoffDelay } = require('../lib/retry');
const { jobsProcessed } = require('../observability/metrics');
const logger = require('../observability/logger');

async function claimJob(db) {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING *`
  );
  return rows[0];
}

async function runOnce(db, handlers) {
  const job = await claimJob(db);
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw Object.assign(new Error(`No handler for ${job.type}`), { permanent: true });
    await handler(job.payload);
    await db.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [job.id]);
    jobsProcessed.inc({ type: job.type, outcome: 'done' });
  } catch (err) {
    const dead = err.permanent || job.attempts >= job.max_attempts;
    const delay = backoffDelay(job.attempts, { baseMs: 1000, maxMs: 5 * 60_000 });
    await db.query(
      `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`,
      [job.id, dead ? 'dead' : 'queued', String(err.message).slice(0, 1000), String(delay)]
    );
    jobsProcessed.inc({ type: job.type, outcome: dead ? 'dead' : 'retry' });
    logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, dead, err: err.message }, 'job failed');
  }
  return true;
}

async function start() {
  const db = createDb();
  const handlers = createHandlers({ db });
  let running = true;
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });
  logger.info('worker started');
  while (running) {
    const didWork = await runOnce(db, handlers).catch((err) => {
      logger.error({ err }, 'worker loop error');
      return false;
    });
    if (!didWork) await new Promise((r) => setTimeout(r, 500));
  }
  await db.close();
}

if (require.main === module) start();

module.exports = { runOnce, claimJob };
