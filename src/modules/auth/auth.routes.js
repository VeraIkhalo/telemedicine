const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');

const password = z
  .string()
  .min(10)
  .max(128)
  .regex(/[A-Z]/, 'needs an uppercase letter')
  .regex(/[a-z]/, 'needs a lowercase letter')
  .regex(/[0-9]/, 'needs a digit');

const registerSchema = z
  .object({
    email: z.string().email().max(254).transform((e) => e.toLowerCase()),
    password,
    fullName: z.string().min(1).max(120),
    phone: z.string().max(20).optional(),
    // Admins are never self-registered; they are created by seed/ops.
    role: z.enum(['patient', 'doctor']).default('patient'),
    doctor: z
      .object({
        specialization: z.string().min(2).max(80),
        yearsExperience: z.number().int().min(0).max(70),
        feeCents: z.number().int().min(0).max(10_000_000),
        languages: z.array(z.string().max(30)).max(10).default([]),
        bio: z.string().max(2000).optional(),
      })
      .optional(),
  })
  .refine((v) => v.role !== 'doctor' || v.doctor, { message: 'doctor details required for doctor role', path: ['doctor'] });

const loginSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const totpSchema = z.object({ totp: z.string().regex(/^\d{6}$/) });

function createAuthRouter(service) {
  const r = express.Router();
  // Stricter limit on credential endpoints to slow brute force / credential stuffing.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  r.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
    try {
      res.status(201).json(await service.register(req.body, req));
    } catch (e) { next(e); }
  });

  r.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
    try {
      res.json(await service.login(req.body, req));
    } catch (e) { next(e); }
  });

  r.get('/me', authenticate, async (req, res, next) => {
    try { res.json(await service.me(req.user.id)); } catch (e) { next(e); }
  });

  r.post('/mfa/setup', authenticate, async (req, res, next) => {
    try { res.json(await service.setupMfa(req.user.id)); } catch (e) { next(e); }
  });

  r.post('/mfa/enable', authenticate, validate(totpSchema), async (req, res, next) => {
    try { res.json(await service.enableMfa(req.user.id, req.body.totp, req)); } catch (e) { next(e); }
  });

  return r;
}

module.exports = { createAuthRouter };
