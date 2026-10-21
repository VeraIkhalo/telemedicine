const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/auth');

const searchSchema = z.object({
  specialization: z.string().max(80).optional(),
  language: z.string().max(30).optional(),
  minFee: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().int().min(0).optional(),
  q: z.string().max(100).optional(),
  availableOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const slotsSchema = z.object({
  slots: z
    .array(z.object({ startTime: z.string().datetime({ offset: true }), endTime: z.string().datetime({ offset: true }) }))
    .min(1)
    .max(100),
});

const rangeSchema = z.object({
  from: z.string().datetime({ offset: true }).default(() => new Date().toISOString()),
  to: z.string().datetime({ offset: true }).default(() => new Date(Date.now() + 14 * 864e5).toISOString()),
});

const idParam = z.object({ id: z.string().uuid() });

function createDoctorsRouter(service) {
  const r = express.Router();

  r.get('/', validate(searchSchema, 'query'), async (req, res, next) => {
    try { res.json(await service.search(req.query)); } catch (e) { next(e); }
  });

  r.post('/me/slots', authenticate, authorize('doctor'), validate(slotsSchema), async (req, res, next) => {
    try { res.status(201).json(await service.addSlots(req.user.id, req.body.slots, req)); } catch (e) { next(e); }
  });

  r.get('/:id/slots', validate(idParam, 'params'), validate(rangeSchema, 'query'), async (req, res, next) => {
    try { res.json(await service.listSlots(req.params.id, req.query)); } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createDoctorsRouter };
