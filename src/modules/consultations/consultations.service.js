const { audit } = require('../../lib/audit');
const { enqueue } = require('../../lib/jobs');
const { canTransition, TRANSITIONS } = require('../../lib/stateMachine');
const { bookings } = require('../../observability/metrics');
const { notFound, forbidden, conflict, badRequest } = require('../../lib/errors');

function createConsultationsService({ db, cipher, cache }) {
  // Booking = step 1 of the booking saga.
  // In ONE transaction: lock slot row (FOR UPDATE), mark booked, create consultation (pending_payment),
  // create pending payment, enqueue payment job (outbox), write audit log.
  // Step 2 (worker): charge payment -> consultation 'scheduled', or compensate (cancel + reopen slot).
  async function book(patientId, { slotId, reason }, req) {
    try {
      const result = await db.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT s.id, s.doctor_id, s.status, s.start_time, d.fee_cents
           FROM availability_slots s JOIN doctors d ON d.id = s.doctor_id
           WHERE s.id = $1 FOR UPDATE OF s`,
          [slotId]
        );
        const slot = rows[0];
        if (!slot) throw notFound('Slot not found');
        if (slot.status !== 'open') throw conflict('Slot is no longer available');
        if (new Date(slot.start_time) < new Date()) throw badRequest('Slot is in the past');
        if (slot.doctor_id === patientId) throw badRequest('Cannot book yourself');

        await c.query(`UPDATE availability_slots SET status = 'booked', version = version + 1 WHERE id = $1`, [slotId]);
        const cons = await c.query(
          `INSERT INTO consultations (patient_id, doctor_id, slot_id, reason)
           VALUES ($1, $2, $3, $4) RETURNING id, status, doctor_id, slot_id, created_at`,
          [patientId, slot.doctor_id, slotId, reason || null]
        );
        const consultation = cons.rows[0];
        const pay = await c.query(
          'INSERT INTO payments (consultation_id, amount_cents) VALUES ($1, $2) RETURNING id, amount_cents, status',
          [consultation.id, slot.fee_cents]
        );
        await enqueue(c, 'process_payment', { consultationId: consultation.id, paymentId: pay.rows[0].id });
        await audit(c, { actorId: patientId, action: 'consultation.book', entity: 'consultation', entityId: consultation.id, metadata: { slotId }, req });
        return { ...consultation, payment: pay.rows[0] };
      });
      bookings.inc({ outcome: 'success' });
      cache.delByPrefix('doctors:');
      return result;
    } catch (err) {
      bookings.inc({ outcome: err.status === 409 || err.code === '23505' ? 'conflict' : 'error' });
      if (err.code === '23505') throw conflict('Slot is no longer available');
      throw err;
    }
  }

  async function getForUser(id, user) {
    const { rows } = await db.query('SELECT * FROM consultations WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw notFound('Consultation not found');
    // Object-level authorization (prevents IDOR): only participants or admin.
    if (user.role !== 'admin' && c.patient_id !== user.id && c.doctor_id !== user.id) throw notFound('Consultation not found');
    return c;
  }

  async function get(id, user, req) {
    const c = await getForUser(id, user);
    const { rows: rx } = await db.query('SELECT id, items, advice, created_at FROM prescriptions WHERE consultation_id = $1', [id]);
    await audit(db, { actorId: user.id, action: 'consultation.view', entity: 'consultation', entityId: id, req });
    const { notes_enc, ...rest } = c;
    return { ...rest, notes: cipher.decrypt(notes_enc), prescriptions: rx };
  }

  async function list(user, { status, page, limit }) {
    const col = user.role === 'doctor' ? 'doctor_id' : 'patient_id';
    const params = [user.id];
    let sql = `SELECT c.id, c.patient_id, c.doctor_id, c.slot_id, c.status, c.reason, c.created_at,
                      s.start_time, pp.full_name AS patient_name, dp.full_name AS doctor_name
               FROM consultations c
               JOIN availability_slots s ON s.id = c.slot_id
               JOIN profiles pp ON pp.user_id = c.patient_id
               JOIN profiles dp ON dp.user_id = c.doctor_id
               WHERE c.${col} = $1`;
    if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }
    params.push(limit, (page - 1) * limit);
    sql += ` ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await db.query(sql, params);
    return { page, limit, data: rows };
  }

  async function transition(id, user, { status, notes }, req) {
    return db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM consultations WHERE id = $1 FOR UPDATE', [id]);
      const cons = rows[0];
      if (!cons || (user.role !== 'admin' && cons.patient_id !== user.id && cons.doctor_id !== user.id)) {
        throw notFound('Consultation not found');
      }
      if (!canTransition(cons.status, status, user.role)) {
        // Valid transition but wrong role -> 403; impossible transition -> 409.
        if (TRANSITIONS[cons.status]?.[status]) throw forbidden(`Role ${user.role} cannot set status ${status}`);
        throw conflict(`Cannot move from ${cons.status} to ${status} as ${user.role}`);
      }
      const notesEnc = notes != null ? cipher.encrypt(notes) : cons.notes_enc;
      const upd = await c.query(
        'UPDATE consultations SET status = $2, notes_enc = $3, updated_at = now() WHERE id = $1 RETURNING id, status, updated_at',
        [id, status, notesEnc]
      );
      if (status === 'cancelled') {
        await c.query(`UPDATE availability_slots SET status = 'open', version = version + 1 WHERE id = $1`, [cons.slot_id]);
        await enqueue(c, 'refund_payment', { consultationId: id });
      }
      await enqueue(c, 'notify', { consultationId: id, event: `consultation.${status}` });
      await audit(c, { actorId: user.id, action: `consultation.${status}`, entity: 'consultation', entityId: id, metadata: { from: cons.status }, req });
      return upd.rows[0];
    });
  }

  async function prescribe(id, user, { items, advice }, req) {
    return db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM consultations WHERE id = $1 FOR SHARE', [id]);
      const cons = rows[0];
      if (!cons) throw notFound('Consultation not found');
      if (cons.doctor_id !== user.id) throw forbidden('Only the treating doctor can prescribe');
      if (!['in_progress', 'completed'].includes(cons.status)) throw conflict('Consultation must be in progress or completed');
      const { rows: rx } = await c.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, items, advice)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, consultation_id, items, advice, created_at`,
        [id, user.id, cons.patient_id, JSON.stringify(items), advice || null]
      );
      await enqueue(c, 'generate_prescription_pdf', { prescriptionId: rx[0].id });
      await audit(c, { actorId: user.id, action: 'prescription.create', entity: 'prescription', entityId: rx[0].id, metadata: { consultationId: id }, req });
      return rx[0];
    });
  }

  return { book, get, list, transition, prescribe };
}

module.exports = { createConsultationsService };
