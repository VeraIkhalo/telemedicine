// Minimal forward-only migration runner. Tracks applied files in schema_migrations.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../src/config');

async function migrate(connectionString = config.databaseUrl) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
    const dir = path.join(__dirname, '..', 'migrations');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) continue;
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(() => console.log('migrations complete')).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { migrate };
