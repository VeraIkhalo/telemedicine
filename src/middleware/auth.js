const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../lib/errors');

// Verifies the Bearer JWT and attaches { id, role } to req.user.
function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(unauthorized('Invalid or expired token'));
  }
}

// RBAC guard: authorize('admin'), authorize('doctor', 'admin'), ...
function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtTtl,
  });
}

module.exports = { authenticate, authorize, signToken };
