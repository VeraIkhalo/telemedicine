# Amrutam Telemedicine Backend

Backend for Amrutam's telemedicine platform, built with Node.js (Express) and PostgreSQL.

It covers sign-up and login (with MFA and roles), doctor search and availability, booking, the consultation lifecycle, prescriptions, audit logs and admin analytics.

**Docs:** [Architecture](docs/ARCHITECTURE.md) · [Security & threat model](docs/SECURITY.md) · [API spec](docs/openapi.yaml)

## Running it

Needs Node.js 20+. No Docker or PostgreSQL install required — `npm run db` starts a portable PostgreSQL.

```bash
npm install
cp .env.example .env
npm run db          # terminal 1 — database (leave running)
npm run migrate
npm run seed        # demo users, doctors and slots
npm start           # terminal 2 — app on http://localhost:3000
npm run worker      # terminal 3 — background jobs (payments, notifications)
```

Or with Docker: `docker compose up --build`, then `docker compose exec api node scripts/seed.js`.
This also starts Prometheus (:9090), Grafana (:3001) and Jaeger (:16686).

## Trying it out

Open **http://localhost:3000** and log in with a demo account (password `Passw0rd!234`):

| Role | Email |
|---|---|
| Patient | patient@amrutam.dev |
| Doctor | doctor@amrutam.dev |
| Admin | admin@amrutam.dev |

API reference: http://localhost:3000/docs · Metrics: http://localhost:3000/metrics

## Tests

```bash
npm test
```

With `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/amrutam_test` set, this also runs the integration tests against a real database, including a test that fires 4 simultaneous bookings at one slot and checks exactly one succeeds. CI runs these on every push (`.github/workflows/ci.yml`).

## Key design decisions

- **No double booking:** the slot row is locked during booking, and a unique index backs it up.
- **Idempotent writes:** bookings and other writes need an `Idempotency-Key` header. Retrying returns the original result instead of repeating the action.
- **Payments as a saga:** booking reserves the slot and queues a payment job in one transaction. The worker charges, then confirms the booking, or cancels it and frees the slot if payment fails.
- **Security:** hashed passwords, MFA, role checks, server-side logout, encrypted clinical notes, an append-only audit log, rate limiting and input validation.
- **Observability:** structured logs with request IDs, Prometheus metrics with latency alerts, OpenTelemetry tracing.

## Layout

```
src/modules/      auth, doctors, consultations, admin (routes + services)
src/middleware/   auth/roles, idempotency, validation, errors
src/jobs/         background worker and job handlers
migrations/       database schema
infra/            Terraform (AWS) and Kubernetes manifests
public/           web test page
tests/            unit and integration tests
```
