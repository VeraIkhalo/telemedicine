const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./observability/logger');
const { register, metricsMiddleware } = require('./observability/metrics');
const { errorHandler } = require('./middleware/errorHandler');
const { createAuthRouter } = require('./modules/auth/auth.routes');
const { createDoctorsRouter } = require('./modules/doctors/doctors.routes');
const { createConsultationsRouter } = require('./modules/consultations/consultations.routes');
const { createAdminRouter } = require('./modules/admin/admin.routes');

function createApp(container) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind load balancer; needed for correct client IPs in rate limit/audit

  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.headers['x-request-id'] || crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    })
  );
  app.use(metricsMiddleware);

  // Ops endpoints (not rate limited)
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await container.db.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  // Global per-IP limit. In multi-replica prod, back this with Redis (rate-limit-redis).
  app.use('/api', rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMin, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.use('/api/v1/auth', createAuthRouter(container.authService));
  app.use('/api/v1/doctors', createDoctorsRouter(container.doctorsService));
  app.use('/api/v1/consultations', createConsultationsRouter(container.consultationsService, container.db));
  app.use('/api/v1/admin', createAdminRouter(container.adminService));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
