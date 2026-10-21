const { Pool } = require('pg');
const config = require('./config');
const { dbQueryDuration } = require('./observability/metrics');

function createDb(connectionString = config.databaseUrl) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: 30000,
    statement_timeout: 5000, // fail fast; protects p95 latency
  });

  async function query(text, params) {
    const end = dbQueryDuration.startTimer();
    try {
      return await pool.query(text, params);
    } finally {
      end();
    }
  }

  // Runs fn inside a transaction. Retries on serialization failure / deadlock with backoff.
  async function tx(fn, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const retryable = err.code === '40001' || err.code === '40P01';
        if (retryable && attempt < retries) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 25 + Math.random() * 25));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  return { pool, query, tx, close: () => pool.end() };
}

module.exports = { createDb };
