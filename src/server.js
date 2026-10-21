const config = require('./config');
const logger = require('./observability/logger');
const { createContainer } = require('./container');
const { createApp } = require('./app');

const container = createContainer();
const app = createApp(container);
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));

// Graceful shutdown: stop accepting connections, finish in-flight requests, close DB pool.
function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await container.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
