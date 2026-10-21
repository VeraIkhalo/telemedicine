const pino = require('pino');
const config = require('../config');

// Structured JSON logs. Sensitive fields are redacted before they leave the process.
const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.totp',
      '*.mfaSecret',
      '*.notes',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
