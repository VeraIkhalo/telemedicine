const { badRequest } = require('../lib/errors');

// Validates and replaces req[source] with the parsed (typed, stripped) value.
const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) return next(badRequest('Validation failed', result.error.flatten()));
  req[source] = result.data;
  next();
};

module.exports = { validate };
