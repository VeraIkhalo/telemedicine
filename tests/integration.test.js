// End-to-end tests against a real PostgreSQL. Runs when TEST_DATABASE_URL is set (CI sets it).
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { migrate } = require('../scripts/migrate');
const { createDb } = require('../src/db');
const { createContainer } = require('../src/container');
const { createApp } = require('../src/app');
const { createHandlers } = require('../src/jobs/handlers');
const { runOnce } = require('../src/jobs/worker');

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('telemedicine API (integration)', () => {
  let db, app, handlers, doctorId, slotIds;
  const tokens = {};
  const PASSWORD = 'Passw0rd!234';

  const login = async (email) => {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken;
  };
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const drainJobs = async () => { while (await runOnce(db, handlers)); };

  beforeAll(async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
    await migrate(url);

    db = createDb(url);
    app = createApp(createContainer({ db }));
    handlers = createHandlers({ db });

    // admin + verified doctor with slots are provisioned directly (as ops would)
    const hash = await bcrypt.hash(PASSWORD, 4);
    const mk = async (email, role) => {
      const { rows } = await db.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id', [email, hash, role]);
      await db.query('INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)', [rows[0].id, email]);
      return rows[0].id;
    };
    await mk('admin@t.dev', 'admin');
    doctorId = await mk('doc@t.dev', 'doctor');
    await db.query(`INSERT INTO doctors (id, specialization, fee_cents, languages, verified) VALUES ($1, 'Ayurveda', 50000, '{hindi}', TRUE)`, [doctorId]);
    slotIds = [];
    for (let i = 1; i <= 3; i++) {
      const start = new Date(Date.now() + i * 86400_000);
      const { rows } = await db.query(
        'INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1, $2, $3) RETURNING id',
        [doctorId, start, new Date(start.getTime() + 1800_000)]
      );
      slotIds.push(rows[0].id);
    }
    tokens.admin = await login('admin@t.dev');
    tokens.doctor = await login('doc@t.dev');
  });

  afterAll(async () => { await db?.close(); });

  test('registers patients with validation', async () => {
    const weak = await request(app).post('/api/v1/auth/register').send({ email: 'x@t.dev', password: 'weak', fullName: 'X' });
    expect(weak.status).toBe(400);

    for (const email of ['p1@t.dev', 'p2@t.dev']) {
      const res = await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: email });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('patient');
    }
    const admin = await request(app).post('/api/v1/auth/register').send({ email: 'evil@t.dev', password: PASSWORD, fullName: 'E', role: 'admin' });
    expect(admin.status).toBe(400); // cannot self-register as admin
    tokens.p1 = await login('p1@t.dev');
    tokens.p2 = await login('p2@t.dev');
  });

  test('searches doctors with filters', async () => {
    const res = await request(app).get('/api/v1/doctors').query({ specialization: 'ayurveda', language: 'hindi', maxFee: 60000 });
    expect(res.status).toBe(200);
    expect(res.body.data.map((x) => x.id)).toContain(doctorId);
    const none = await request(app).get('/api/v1/doctors').query({ maxFee: 100 });
    expect(none.body.data).toHaveLength(0);
  });

  test('booking requires Idempotency-Key and replays on retry', async () => {
    const noKey = await request(app).post('/api/v1/consultations').set(auth(tokens.p1)).send({ slotId: slotIds[0] });
    expect(noKey.status).toBe(400);

    const first = await request(app).post('/api/v1/consultations').set(auth(tokens.p1)).set('Idempotency-Key', 'k-1').send({ slotId: slotIds[0] });
    expect(first.status).toBe(201);
    const replay = await request(app).post('/api/v1/consultations').set(auth(tokens.p1)).set('Idempotency-Key', 'k-1').send({ slotId: slotIds[0] });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM consultations WHERE slot_id = $1', [slotIds[0]]);
    expect(rows[0].n).toBe(1);
  });

  test('concurrent bookings of the same slot: exactly one wins', async () => {
    const results = await Promise.all(
      [tokens.p1, tokens.p2, tokens.p1, tokens.p2].map((t, i) =>
        request(app).post('/api/v1/consultations').set(auth(t)).set('Idempotency-Key', `race-${i}`).send({ slotId: slotIds[1] })
      )
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(3);
  });

  test('full lifecycle: payment saga -> start -> prescribe -> complete', async () => {
    const book = await request(app).post('/api/v1/consultations').set(auth(tokens.p2)).set('Idempotency-Key', 'life-1').send({ slotId: slotIds[2] });
    expect(book.status).toBe(201);
    expect(book.body.status).toBe('pending_payment');
    const id = book.body.id;

    await drainJobs();
    const after = await request(app).get(`/api/v1/consultations/${id}`).set(auth(tokens.p2));
    expect(after.body.status).toBe('scheduled');

    // IDOR protection: another patient can't see it
    const other = await request(app).get(`/api/v1/consultations/${id}`).set(auth(tokens.p1));
    expect(other.status).toBe(404);

    // patient cannot start a consultation
    const bad = await request(app).patch(`/api/v1/consultations/${id}/status`).set(auth(tokens.p2)).set('Idempotency-Key', 's0').send({ status: 'in_progress' });
    expect(bad.status).toBe(403);

    const start = await request(app).patch(`/api/v1/consultations/${id}/status`).set(auth(tokens.doctor)).set('Idempotency-Key', 's1').send({ status: 'in_progress', notes: 'Vata imbalance' });
    expect(start.body.status).toBe('in_progress');

    const rx = await request(app)
      .post(`/api/v1/consultations/${id}/prescriptions`)
      .set(auth(tokens.doctor))
      .set('Idempotency-Key', 'rx1')
      .send({ items: [{ medicine: 'Triphala', dosage: '1 tsp', frequency: 'nightly', durationDays: 30 }] });
    expect(rx.status).toBe(201);

    const done = await request(app).patch(`/api/v1/consultations/${id}/status`).set(auth(tokens.doctor)).set('Idempotency-Key', 's2').send({ status: 'completed' });
    expect(done.body.status).toBe('completed');

    const view = await request(app).get(`/api/v1/consultations/${id}`).set(auth(tokens.p2));
    expect(view.body.notes).toBe('Vata imbalance');
    expect(view.body.prescriptions).toHaveLength(1);

    // notes are encrypted at rest
    const { rows } = await db.query('SELECT notes_enc FROM consultations WHERE id = $1', [id]);
    expect(rows[0].notes_enc).not.toContain('Vata');
  });

  test('payment failure triggers compensation (slot reopened)', async () => {
    process.env.PAYMENT_FAIL_ALL = 'true';
    try {
      const start = new Date(Date.now() + 10 * 86400_000);
      const { rows } = await db.query(
        'INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1, $2, $3) RETURNING id',
        [doctorId, start, new Date(start.getTime() + 1800_000)]
      );
      const res = await request(app).post('/api/v1/consultations').set(auth(tokens.p1)).set('Idempotency-Key', 'fail-1').send({ slotId: rows[0].id });
      expect(res.status).toBe(201);
      await drainJobs();
      const c = await db.query('SELECT status FROM consultations WHERE id = $1', [res.body.id]);
      const s = await db.query('SELECT status FROM availability_slots WHERE id = $1', [rows[0].id]);
      expect(c.rows[0].status).toBe('cancelled');
      expect(s.rows[0].status).toBe('open');
    } finally {
      delete process.env.PAYMENT_FAIL_ALL;
    }
  });

  test('admin analytics and audit logs are admin-only', async () => {
    const denied = await request(app).get('/api/v1/admin/analytics').set(auth(tokens.p1));
    expect(denied.status).toBe(403);

    const res = await request(app).get('/api/v1/admin/analytics').set(auth(tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBeGreaterThan(0);

    const logs = await request(app).get('/api/v1/admin/audit-logs').query({ entity: 'consultation' }).set(auth(tokens.admin));
    expect(logs.body.length).toBeGreaterThan(0);
  });

  test('search matches partial name/specialty text', async () => {
    const partial = await request(app).get('/api/v1/doctors').query({ q: 'ayur' });
    expect(partial.body.data.map((x) => x.id)).toContain(doctorId);
    const generic = await request(app).get('/api/v1/doctors').query({ q: 'doctor' });
    expect(generic.body.data.length).toBeGreaterThan(0);
    const wildcard = await request(app).get('/api/v1/doctors').query({ q: '%' });
    expect(wildcard.body.data).toHaveLength(0); // "%" is matched literally, not as a wildcard
  });

  test('logout ends the session server-side: the old token is rejected everywhere', async () => {
    const token = await login('p1@t.dev');
    expect((await request(app).get('/api/v1/auth/me').set(auth(token))).status).toBe(200);

    const out = await request(app).post('/api/v1/auth/logout').set(auth(token));
    expect(out.status).toBe(200);

    expect((await request(app).get('/api/v1/auth/me').set(auth(token))).status).toBe(401);
    const book = await request(app).post('/api/v1/consultations').set(auth(token)).set('Idempotency-Key', 'after-logout').send({ slotId: slotIds[0] });
    expect(book.status).toBe(401);

    // other sessions of the same user are unaffected
    expect((await request(app).get('/api/v1/auth/me').set(auth(tokens.p1))).status).toBe(200);
  });

  test('audit logs are append-only', async () => {
    await expect(db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });
});
