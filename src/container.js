// Composition root: builds every dependency once and injects it into services.
// Tests can pass their own db/cache to swap implementations.
const config = require('./config');
const { createDb } = require('./db');
const { createCache } = require('./lib/cache');
const { createCipher } = require('./lib/crypto');
const { createAuthService } = require('./modules/auth/auth.service');
const { createDoctorsService } = require('./modules/doctors/doctors.service');
const { createConsultationsService } = require('./modules/consultations/consultations.service');
const { createAdminService } = require('./modules/admin/admin.service');

function createContainer(overrides = {}) {
  const db = overrides.db || createDb();
  const cache = overrides.cache || createCache({ ttlMs: config.cacheTtlMs });
  const cipher = overrides.cipher || createCipher(config.encryptionKeys);
  const deps = { db, cache, cipher };

  return {
    ...deps,
    authService: createAuthService(deps),
    doctorsService: createDoctorsService(deps),
    consultationsService: createConsultationsService(deps),
    adminService: createAdminService(deps),
  };
}

module.exports = { createContainer };
