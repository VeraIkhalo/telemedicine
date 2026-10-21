# 5-minute demo video script

**0:00–0:40 — Intro + architecture.** Open `docs/ARCHITECTURE.md`: show the architecture diagram, say "modular monolith in Node.js + PostgreSQL, stateless API pods, background worker, outbox-based saga for payments".

**0:40–1:20 — Run it.** `docker compose up --build`, then `docker compose exec api node scripts/seed.js`. Show `http://localhost:3000/readyz`.

**1:20–2:40 — Core flow (curl / Postman).**
1. Log in as `patient@amrutam.dev` / `Passw0rd!234` → JWT.
2. `GET /api/v1/doctors?specialization=ayurveda` → search results.
3. `GET /api/v1/doctors/{id}/slots` → pick a slot.
4. `POST /api/v1/consultations` with `Idempotency-Key: demo-1` → 201 `pending_payment`.
5. Send the **same request again** → same response + `Idempotent-Replayed: true` (no double booking).
6. `GET /api/v1/consultations/{id}` → now `scheduled` (worker processed the payment).
7. Log in as doctor → `PATCH .../status {in_progress}` → `POST .../prescriptions` → `PATCH .../status {completed}`.

**2:40–3:20 — Security.** Patient calls `/api/v1/admin/analytics` → 403. Another patient reads the consultation → 404 (IDOR protection). Mention MFA endpoints, encrypted notes, append-only audit log. Log in as admin → `GET /admin/audit-logs`.

**3:20–4:10 — Tests + CI.** Run `npm test`; point at the concurrency test (4 parallel bookings → exactly one wins) and the saga compensation test. Show `.github/workflows/ci.yml` (lint, tests with Postgres, npm audit, Trivy, CodeQL).

**4:10–5:00 — Observability.** `http://localhost:3000/metrics`, Prometheus (`http_request_duration_seconds`, `bookings_total`), alert rules for p95 SLOs, Jaeger trace of a booking request. Close with `docs/SECURITY.md` threat model.
