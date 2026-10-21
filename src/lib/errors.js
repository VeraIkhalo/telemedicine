class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg) => new AppError(409, 'CONFLICT', msg);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
