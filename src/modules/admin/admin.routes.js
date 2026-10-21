const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/auth');

const analyticsSchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(7) });
const auditSchema = z.object({
  entity: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const idParam = z.object({ id: z.string().uuid() });

function createAdminRouter(service) {
  const r = express.Router();
  r.use(authenticate, authorize('admin'));

  r.get('/analytics', validate(analyticsSchema, 'query'), async (req, res, next) => {
    try { res.json(await service.analytics(req.query)); } catch (e) { next(e); }
  });

  r.get('/audit-logs', validate(auditSchema, 'query'), async (req, res, next) => {
    try { res.json(await service.auditLogs(req.query)); } catch (e) { next(e); }
  });

  r.post('/doctors/:id/verify', validate(idParam, 'params'), async (req, res, next) => {
    try { res.json(await service.verifyDoctor(req.user.id, req.params.id, req)); } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createAdminRouter };
