const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { authenticate, authorize } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');

const bookSchema = z.object({ slotId: z.string().uuid(), reason: z.string().max(500).optional() });
const idParam = z.object({ id: z.string().uuid() });
const listSchema = z.object({
  status: z.enum(['pending_payment', 'scheduled', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const statusSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'cancelled', 'no_show']),
  notes: z.string().max(5000).optional(),
});
const rxSchema = z.object({
  items: z
    .array(
      z.object({
        medicine: z.string().min(1).max(120),
        dosage: z.string().max(60),
        frequency: z.string().max(60),
        durationDays: z.number().int().min(1).max(365),
      })
    )
    .min(1)
    .max(30),
  advice: z.string().max(2000).optional(),
});

function createConsultationsRouter(service, db) {
  const r = express.Router();
  r.use(authenticate);
  const idem = idempotency(db);

  r.post('/', authorize('patient'), validate(bookSchema), idem, async (req, res, next) => {
    try { res.status(201).json(await service.book(req.user.id, req.body, req)); } catch (e) { next(e); }
  });

  r.get('/', validate(listSchema, 'query'), async (req, res, next) => {
    try { res.json(await service.list(req.user, req.query)); } catch (e) { next(e); }
  });

  r.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
    try { res.json(await service.get(req.params.id, req.user, req)); } catch (e) { next(e); }
  });

  r.patch('/:id/status', validate(idParam, 'params'), validate(statusSchema), idem, async (req, res, next) => {
    try { res.json(await service.transition(req.params.id, req.user, req.body, req)); } catch (e) { next(e); }
  });

  r.post('/:id/prescriptions', authorize('doctor'), validate(idParam, 'params'), validate(rxSchema), idem, async (req, res, next) => {
    try { res.status(201).json(await service.prescribe(req.params.id, req.user, req.body, req)); } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createConsultationsRouter };
