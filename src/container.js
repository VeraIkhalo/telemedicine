// Composition root: builds every dependency once and injects it into services.
// Tests can pass their own db/cache to swap implementations.
const config = require('./config');
const { createDb } = require('./db');
const { createCache } = require('./lib/cache');
const { createCipher } = require('./lib/crypto');
const { setSessionValidator } = require('./middleware/auth');
const { createAuthService } = require('./modules/auth/auth.service');
const { createDoctorsService } = require('./modules/doctors/doctors.service');
const { createConsultationsService } = require('./modules/consultations/consultations.service');
const { createAdminService } = require('./modules/admin/admin.service');

function createContainer(overrides = {}) {
  const db = overrides.db || createDb();
  const cache = overrides.cache || createCache({ ttlMs: config.cacheTtlMs });
  const cipher = overrides.cipher || createCipher(config.encryptionKeys);
  const deps = { db, cache, cipher };

  // Every authenticated request checks its session is still live (PK lookup, ~1 ms).
  // At larger scale, cache revoked session IDs in Redis instead.
  setSessionValidator(async (sid, userId) => {
    if (!sid) return false;
    const { rowCount } = await db.query(
      'SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()',
      [sid, userId]
    );
    return rowCount === 1;
  });

  return {
    ...deps,
    authService: createAuthService(deps),
    doctorsService: createDoctorsService(deps),
    consultationsService: createConsultationsService(deps),
    adminService: createAdminService(deps),
  };
}

module.exports = { createContainer };
