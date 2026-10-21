const { AppError } = require('../lib/errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
  }
  req.log?.error({ err }, 'unhandled error');
  // Never leak stack traces or SQL to clients.
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.id } });
}

module.exports = { errorHandler };
