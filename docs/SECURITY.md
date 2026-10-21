# Security Checklist and Threat Model

## 1. Security checklist

| Control | Status | Where |
|---|---|---|
| Passwords hashed with bcrypt (cost 12), strong password policy | ✅ | `auth.service.js`, `auth.routes.js` |
| MFA (TOTP, RFC 6238) with encrypted secret | ✅ | `/auth/mfa/setup`, `/auth/mfa/enable`, login `totp` |
| Short-lived JWT (15 min), algorithm pinned to HS256 | ✅ | `middleware/auth.js` |
| RBAC (patient / doctor / admin) on every protected route | ✅ | `authorize()` |
| Object-level authorization (no IDOR): only participants/admin can read a consultation | ✅ | `consultations.service.js` |
| Admin cannot be self-registered | ✅ | register schema allows only patient/doctor |
| Input validation (zod) on body, query, params; unknown fields stripped | ✅ | `middleware/validate.js` |
| Parameterised SQL only (no string-built queries with input) | ✅ | all services |
| Rate limiting: global 300/min/IP, auth 20/15 min/IP | ✅ | `app.js`, `auth.routes.js` |
| Idempotency keys required on all writes that create/change clinical or payment data | ✅ | `middleware/idempotency.js` |
| Field-level encryption AES-256-GCM (MFA secrets, clinical notes) with key versioning | ✅ | `lib/crypto.js` |
| Encryption at rest (RDS + KMS), in transit (TLS at LB, TLS to RDS/Redis) | ✅ | `infra/terraform/main.tf` |
| Secrets only via env vars / Secrets Manager; prod refuses to start without them | ✅ | `config.js` |
| Security headers (helmet), `x-powered-by` disabled, 100 kb body limit | ✅ | `app.js` |
| No stack traces / SQL errors leaked to clients | ✅ | `errorHandler.js` |
| Log redaction of tokens, passwords, TOTP, notes | ✅ | `observability/logger.js` |
| Append-only audit log (DB trigger blocks UPDATE/DELETE), written in same tx as change | ✅ | migration, `lib/audit.js` |
| Login failures and MFA failures audited; generic error prevents user enumeration | ✅ | `auth.service.js` |
| Non-root, minimal container; read-only root FS in k8s | ✅ | `Dockerfile`, `infra/k8s` |
| Dependency scanning (`npm audit`), image scanning (Trivy), SAST (CodeQL) in CI | ✅ | `.github/workflows/ci.yml` |
| Server-side sessions: logout revokes the token immediately (checked on every request) | ✅ | `sessions` table, `middleware/auth.js`, `POST /auth/logout` |
| Refresh tokens | 🔜 roadmap | |

## 2. Data classification

| Class | Examples | Controls |
|---|---|---|
| **Restricted (PHI)** | Clinical notes, prescriptions, consultation reason | Field encryption (notes), RBAC + participant check, every read audited, never cached, never logged |
| **Confidential (PII / secrets)** | Email, phone, DOB, password hash, MFA secret, payment refs | Encrypted at rest, MFA secret field-encrypted, redacted in logs |
| **Internal** | Audit logs, analytics, job payloads (IDs only) | Admin-only APIs, WORM archive |
| **Public** | Doctor name, specialization, fee, languages, rating | Cached, unauthenticated search |

Applicable regimes: India DPDP Act 2023, Telemedicine Practice Guidelines 2020 (record retention), HIPAA-style controls as baseline.

## 3. Encryption and key rotation

* **In transit:** TLS 1.2+ at load balancer; `sslmode=require` to RDS; Redis in-transit encryption.
* **At rest:** RDS storage + snapshots encrypted with a KMS key (`enable_key_rotation = true`).
* **Application layer:** AES-256-GCM, random 96-bit IV per value, auth tag verified on decrypt (tamper detection).
* **Rotation:** `ENCRYPTION_KEYS="v2:<new>,v1:<old>"`. New writes use `v2`; old ciphertext (prefixed `v1:`) still decrypts. A background re-encryption job uses `needsRotation()` to rewrite old rows, after which `v1` is removed. Tested in `tests/unit.test.js`.
* **JWT secret rotation:** deploy with new secret; tokens live 15 min, so old tokens expire quickly (dual-key verification is a small extension). Every token is also bound to a server-side session, so logout or an admin can revoke it instantly.
* **DB credentials:** managed and rotated by AWS Secrets Manager (`manage_master_user_password`).

## 4. Attack surface analysis

| Entry point | Exposure | Main mitigations |
|---|---|---|
| `POST /auth/register`, `/auth/login` | Public | Strict rate limit, validation, bcrypt, generic errors, MFA, audit of failures |
| `GET /doctors`, `/doctors/:id/slots` | Public | Read-only, validated + bounded params (`limit ≤ 50`), cached, only public fields returned |
| `/consultations/*` | Authenticated | JWT + RBAC + participant check + idempotency + state machine |
| `/admin/*` | Admin only | RBAC; admins provisioned out-of-band; MFA should be enforced for admins |
| `/metrics`, `/healthz`, `/readyz` | Internal | Expose only inside the cluster (network policy / not routed through public ingress) |
| Worker → payment provider | Outbound | Provider idempotency key, timeouts, retries with backoff |
| Database | Private subnet | No public access, SG restricted to app pods, least-privilege DB user |
| CI/CD | Supply chain | Lockfile + `npm ci`, npm audit, Trivy, CodeQL, pinned action versions |

## 5. Threat model (STRIDE)

| Threat | Example | Mitigation |
|---|---|---|
| **S**poofing | Stolen password / credential stuffing | MFA, bcrypt, auth rate limit, failed-login audit + alerting |
| **T**ampering | Altering prescriptions or audit records | Only treating doctor can prescribe; audit log append-only via trigger; GCM auth tags on encrypted fields |
| **R**epudiation | Doctor denies writing a prescription | Audit row (actor, action, IP, request ID) committed atomically with every change |
| **I**nformation disclosure | Patient reads another's consultation (IDOR); PHI in logs | Participant check returns 404; log redaction; field encryption; no PHI cached |
| **D**enial of service | Flooding search / booking | Rate limits, body size limit, statement timeout, HPA, WAF at edge |
| **E**levation of privilege | Registering as admin; patient starting a consultation | Admin not self-registrable; RBAC; state machine checks role per transition |

## 6. OWASP API Top 10 (2023) mapping

| Risk | Mitigation |
|---|---|
| API1 Broken object level authorization | Participant/owner checks on every consultation read/write |
| API2 Broken authentication | bcrypt, MFA, short JWT, pinned alg, rate limits |
| API3 Broken object property level authorization | zod strips unknown fields (no mass assignment of `role`, `verified`, `status`) |
| API4 Unrestricted resource consumption | Rate limits, pagination caps, body limit, statement timeout |
| API5 Broken function level authorization | `authorize()` role guards on doctor/admin routes |
| API6 Unrestricted access to sensitive business flows | Idempotency keys + slot locking stop booking abuse/double charging |
| API7 SSRF | No user-supplied URLs are fetched |
| API8 Security misconfiguration | helmet, no stack traces, non-root container, env-only secrets |
| API9 Improper inventory management | Versioned `/api/v1`, single OpenAPI spec |
| API10 Unsafe consumption of APIs | Payment responses validated; retries bounded; provider idempotency keys |

## 7. Dependency scanning

* `npm audit --omit=dev --audit-level=high` fails CI on high/critical issues.
* Trivy scans the built image for OS + library CVEs.
* CodeQL static analysis on every PR.
* Recommended: Dependabot for automated upgrade PRs.
