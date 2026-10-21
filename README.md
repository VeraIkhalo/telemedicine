# Amrutam Telemedicine Backend

Node.js (Express) + PostgreSQL backend for Amrutam's telemedicine platform: auth with MFA and roles, doctor availability and booking, consultation lifecycle and prescriptions, search, audit trails, and admin analytics.

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, booking sequence diagram, ER diagram, retries, partitioning, caching/concurrency, sagas, backup/DR |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3 spec (paste into https://editor.swagger.io) |
| [docs/SECURITY.md](docs/SECURITY.md) | Security checklist, data classification, threat model (STRIDE), OWASP mapping, key rotation |

## Quick start (Docker — everything in one command)

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3000 (health: `/healthz`, `/readyz`, metrics: `/metrics`) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 |
| Jaeger (traces) | http://localhost:16686 |

Seed demo users (admin, verified doctor with slots, patient — password `Passw0rd!234`):

```bash
docker compose exec api node scripts/seed.js
```

## Fastest local run (no Docker, no Postgres install)

Uses a portable PostgreSQL from npm on port 5433. Run each in its own terminal:

```bash
npm install
npm run db                    # terminal 1: portable Postgres (keep open)
# create .env with:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5433/amrutam
#   JWT_SECRET=local-dev-secret-change-me
#   ENCRYPTION_KEYS=v1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
npm run migrate && npm run seed
npm start                     # terminal 2: API on :3000
npm run worker                # terminal 3: background jobs
```

## Local development (without Docker)

Requires Node 20+ and PostgreSQL 14+.

```bash
cp .env.example .env          # then edit DATABASE_URL etc.
npm install
npm run migrate
npm run seed
npm run dev                   # API on :3000
npm run worker                # background jobs (payments, notifications, PDFs)
```

## Tests

```bash
npm test                                    # unit tests
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/amrutam_test npm test   # + integration tests
```

The integration suite (runs in CI against a real Postgres) covers: registration validation, search filters, idempotent booking replay, **4 concurrent bookings of one slot → exactly one succeeds**, the payment saga and its compensation, the full consultation lifecycle with prescriptions, encrypted notes, IDOR protection, RBAC on admin routes, and the append-only audit log.

## Demo walkthrough (curl)

```bash
API=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"patient@amrutam.dev","password":"Passw0rd!234"}' | jq -r .accessToken)

# search doctors
curl -s "$API/doctors?specialization=ayurveda&language=hindi" | jq
DOC=$(curl -s "$API/doctors" | jq -r '.data[0].id')
SLOT=$(curl -s "$API/doctors/$DOC/slots" | jq -r '.[0].id')

# book (run twice with the same key -> same response, header Idempotent-Replayed: true)
curl -si -X POST $API/consultations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d "{\"slotId\":\"$SLOT\"}"
```

## Project layout

```
src/
  app.js, server.js, container.js   # express app, process entry, DI composition root
  config.js, db.js                  # env-based config, pg pool + transaction helper with retry
  middleware/                       # auth (JWT+RBAC), idempotency, validation, errors
  modules/{auth,doctors,consultations,admin}/  # routes + services per domain
  lib/                              # crypto (AES-GCM + key rotation), cache, retry, audit, jobs, state machine
  jobs/                             # worker (SKIP LOCKED queue) + handlers (payment saga, refunds, notifications, PDFs)
  observability/                    # pino logger, Prometheus metrics, OpenTelemetry tracing
migrations/                         # SQL schema
infra/terraform, infra/k8s          # RDS Multi-AZ + replica + KMS + Redis; k8s Deployments, HPA, PDB
observability/                      # Prometheus scrape config, SLO alert rules, Grafana datasources
.github/workflows/ci.yml            # tests, npm audit, Docker build, Trivy scan, CodeQL
```

## Key design decisions

* **Idempotency** — every booking/state-change/prescription write requires `Idempotency-Key`; responses are stored and replayed.
* **No double booking** — row lock (`SELECT … FOR UPDATE`) + partial unique index + idempotency.
* **Saga with outbox** — booking commits slot reservation + pending payment + job atomically; the worker charges and either confirms or compensates.
* **Async jobs** — Postgres-backed queue (`FOR UPDATE SKIP LOCKED`), exponential backoff with jitter, dead-letter state.
* **Security** — bcrypt, TOTP MFA, RBAC + object-level checks, AES-256-GCM field encryption with key rotation, append-only audit log, rate limiting, zod validation, env-only secrets.
* **Observability** — request-ID'd JSON logs, Prometheus histograms + SLO alerts (p95 200/500 ms, error budget), OpenTelemetry traces.
