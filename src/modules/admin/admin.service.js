const { audit } = require('../../lib/audit');
const { notFound } = require('../../lib/errors');

function createAdminService({ db, cache }) {
  async function analytics({ days }) {
    const key = `admin:analytics:${days}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const [byStatus, revenue, daily, topDoctors, users] = await Promise.all([
      db.query(`SELECT status, count(*)::int AS count FROM consultations
                WHERE created_at > now() - ($1 || ' days')::interval GROUP BY status`, [String(days)]),
      db.query(`SELECT coalesce(sum(amount_cents), 0)::bigint AS revenue_cents, count(*)::int AS paid
                FROM payments WHERE status = 'succeeded' AND created_at > now() - ($1 || ' days')::interval`, [String(days)]),
      db.query(`SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS consultations
                FROM consultations WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY 1`, [String(days)]),
      db.query(`SELECT c.doctor_id, p.full_name, count(*)::int AS completed
                FROM consultations c JOIN profiles p ON p.user_id = c.doctor_id
                WHERE c.status = 'completed' AND c.created_at > now() - ($1 || ' days')::interval
                GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`, [String(days)]),
      db.query(`SELECT role, count(*)::int AS count FROM users GROUP BY role`),
    ]);

    const result = {
      windowDays: days,
      consultationsByStatus: byStatus.rows,
      revenueCents: Number(revenue.rows[0].revenue_cents),
      paidConsultations: revenue.rows[0].paid,
      daily: daily.rows,
      topDoctors: topDoctors.rows,
      usersByRole: users.rows,
    };
    cache.set(key, result, 60000);
    return result;
  }

  async function auditLogs({ entity, entityId, actorId, limit }) {
    const where = [];
    const params = [];
    if (entity) { params.push(entity); where.push(`entity = $${params.length}`); }
    if (entityId) { params.push(entityId); where.push(`entity_id = $${params.length}`); }
    if (actorId) { params.push(actorId); where.push(`actor_id = $${params.length}`); }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT id, actor_id, action, entity, entity_id, metadata, ip, request_id, created_at FROM audit_logs
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows;
  }

  async function verifyDoctor(adminId, doctorId, req) {
    const { rowCount } = await db.query('UPDATE doctors SET verified = TRUE WHERE id = $1', [doctorId]);
    if (!rowCount) throw notFound('Doctor not found');
    await audit(db, { actorId: adminId, action: 'doctor.verify', entity: 'doctor', entityId: doctorId, req });
    cache.delByPrefix('doctors:');
    return { id: doctorId, verified: true };
  }

  return { analytics, auditLogs, verifyDoctor };
}

module.exports = { createAdminService };
