const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized, forbidden } = require('../lib/errors');

// Checks that the session behind a token is still active (not logged out / expired).
// Wired to the database in container.js; left unset in pure unit tests.
let isSessionActive = null;
function setSessionValidator(fn) {
  isSessionActive = fn;
}

// Verifies the Bearer JWT, then the server-side session, and attaches { id, role, sid } to req.user.
async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
  try {
    if (isSessionActive && !(await isSessionActive(payload.sid, payload.sub))) {
      return next(unauthorized('Session has ended, please log in again'));
    }
  } catch (err) {
    return next(err);
  }
  req.user = { id: payload.sub, role: payload.role, sid: payload.sid };
  next();
}

// RBAC guard: authorize('admin'), authorize('doctor', 'admin'), ...
function authorize(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

function signToken(user, sessionId) {
  return jwt.sign({ sub: user.id, role: user.role, sid: sessionId }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.jwtTtl,
  });
}

module.exports = { authenticate, authorize, signToken, setSessionValidator };
