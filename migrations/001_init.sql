-- Amrutam telemedicine core schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
CREATE TYPE slot_status AS ENUM ('open', 'booked', 'blocked');
CREATE TYPE consultation_status AS ENUM ('pending_payment', 'scheduled', 'in_progress', 'completed', 'cancelled', 'no_show');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,   -- stored lower-cased
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'patient',
  mfa_secret    TEXT,                 -- AES-256-GCM encrypted
  mfa_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  phone      TEXT,                    -- PII
  dob        DATE,                    -- PII
  gender     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialization    TEXT NOT NULL,
  years_experience  INT NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  fee_cents         INT NOT NULL CHECK (fee_cents >= 0),
  languages         TEXT[] NOT NULL DEFAULT '{}',
  bio               TEXT,
  rating            NUMERIC(2,1) NOT NULL DEFAULT 0,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_doctors_search ON doctors (specialization, fee_cents) WHERE verified;
CREATE INDEX idx_doctors_languages ON doctors USING GIN (languages);

CREATE TABLE availability_slots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  UUID NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time   TIMESTAMPTZ NOT NULL,
  status     slot_status NOT NULL DEFAULT 'open',
  version    INT NOT NULL DEFAULT 0,  -- optimistic concurrency counter
  CHECK (end_time > start_time),
  UNIQUE (doctor_id, start_time)
);
CREATE INDEX idx_slots_doctor_time ON availability_slots (doctor_id, start_time) WHERE status = 'open';

CREATE TABLE consultations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  UUID NOT NULL REFERENCES users(id),
  doctor_id   UUID NOT NULL REFERENCES doctors(id),
  slot_id     UUID NOT NULL REFERENCES availability_slots(id),
  status      consultation_status NOT NULL DEFAULT 'pending_payment',
  reason      TEXT,
  notes_enc   TEXT,                   -- clinical notes, AES-256-GCM encrypted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one live consultation per slot: DB-level guarantee against double booking.
CREATE UNIQUE INDEX uq_consultation_active_slot ON consultations (slot_id)
  WHERE status NOT IN ('cancelled');
CREATE INDEX idx_consultations_patient ON consultations (patient_id, created_at DESC);
CREATE INDEX idx_consultations_doctor ON consultations (doctor_id, created_at DESC);

CREATE TABLE prescriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID NOT NULL REFERENCES consultations(id),
  doctor_id       UUID NOT NULL REFERENCES doctors(id),
  patient_id      UUID NOT NULL REFERENCES users(id),
  items           JSONB NOT NULL,     -- [{medicine, dosage, frequency, durationDays}]
  advice          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prescriptions_consultation ON prescriptions (consultation_id);

CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID NOT NULL UNIQUE REFERENCES consultations(id),
  amount_cents    INT NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  provider_ref    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail, range-partitioned by month for retention/archival.
CREATE TABLE audit_logs (
  id         BIGSERIAL,
  actor_id   UUID,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}',
  ip         TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);

-- Block UPDATE/DELETE on audit logs (tamper resistance).
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Idempotency keys for write endpoints.
CREATE TABLE idempotency_keys (
  user_id         UUID NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Durable job queue (outbox pattern). Workers use FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | dead
  attempts   INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_ready ON jobs (run_at) WHERE status = 'queued';
