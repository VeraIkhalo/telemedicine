// All secrets come from environment variables (never committed).
function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

module.exports = {
  env,
  isProd,
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/amrutam'),
  // Dev fallbacks only; production must set real values.
  jwtSecret: required('JWT_SECRET', isProd ? undefined : 'dev-jwt-secret-change-me'),
  jwtTtl: process.env.JWT_TTL || '15m',
  // 32-byte key, base64. Supports rotation: ENCRYPTION_KEYS="v2:<b64>,v1:<b64>" (first = active).
  encryptionKeys: required(
    'ENCRYPTION_KEYS',
    isProd ? undefined : 'v1:' + Buffer.alloc(32, 7).toString('base64')
  ),
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 300),
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 30000),
  logLevel: process.env.LOG_LEVEL || 'info',
};
