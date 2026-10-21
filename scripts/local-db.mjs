// Starts a portable PostgreSQL for local dev (no Docker / system install needed).
// Listens on localhost:5433, user postgres / password postgres. Ctrl+C to stop.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';

const dataDir = './.pgdata';
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: 5433, persistent: true });

if (!fs.existsSync(dataDir)) await pg.initialise();
await pg.start();
for (const name of ['amrutam', 'amrutam_test']) {
  await pg.createDatabase(name).catch(() => {}); // ignore "already exists"
}
console.log('PostgreSQL ready on localhost:5433 (databases: amrutam, amrutam_test)');

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
