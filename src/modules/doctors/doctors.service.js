const { audit } = require('../../lib/audit');
const { badRequest } = require('../../lib/errors');

function createDoctorsService({ db, cache }) {
  // Search verified doctors with filters. Read-heavy -> cache-aside with short TTL.
  async function search(f) {
    const key = 'doctors:search:' + JSON.stringify(f);
    const cached = cache.get(key);
    if (cached) return cached;

    const where = ['d.verified'];
    const params = [];
    // Every "?" in the fragment binds to the same parameterised value (no string interpolation of input).
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', '$' + params.length)); };

    // Escape LIKE wildcards in user input so "%" or "_" are matched literally.
    const like = (s) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    if (f.specialization) add('d.specialization ILIKE ?', like(f.specialization));
    if (f.language) add('? = ANY(d.languages)', f.language.toLowerCase());
    if (f.minFee != null) add('d.fee_cents >= ?', f.minFee);
    if (f.maxFee != null) add('d.fee_cents <= ?', f.maxFee);
    // Free text: matches doctor name, specialty or bio. "Dr"/"doctor" alone matches everyone.
    const q = f.q?.trim().replace(/^(dr\.?|doctors?)\s*/i, '');
    if (f.q && q) add('(p.full_name ILIKE ? OR d.specialization ILIKE ? OR d.bio ILIKE ?)', like(q));
    if (f.availableOn) {
      add(
        `EXISTS (SELECT 1 FROM availability_slots s WHERE s.doctor_id = d.id AND s.status = 'open'
          AND s.start_time >= ?::date AND s.start_time < ?::date + 1)`,
        f.availableOn
      );
    }

    params.push(f.limit, (f.page - 1) * f.limit);
    const { rows } = await db.query(
      `SELECT d.id, p.full_name, d.specialization, d.years_experience, d.fee_cents, d.languages, d.rating
       FROM doctors d JOIN profiles p ON p.user_id = d.id
       WHERE ${where.join(' AND ')}
       ORDER BY d.rating DESC, d.years_experience DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const result = { page: f.page, limit: f.limit, data: rows };
    cache.set(key, result);
    return result;
  }

  async function addSlots(doctorId, slots, req) {
    for (const s of slots) {
      if (new Date(s.endTime) <= new Date(s.startTime)) throw badRequest('endTime must be after startTime');
      if (new Date(s.startTime) < new Date()) throw badRequest('slots must be in the future');
    }
    const created = await db.tx(async (c) => {
      const out = [];
      for (const s of slots) {
        const { rows } = await c.query(
          `INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1, $2, $3)
           ON CONFLICT (doctor_id, start_time) DO NOTHING
           RETURNING id, start_time, end_time, status`,
          [doctorId, s.startTime, s.endTime]
        );
        if (rows[0]) out.push(rows[0]);
      }
      await audit(c, { actorId: doctorId, action: 'slots.create', entity: 'doctor', entityId: doctorId, metadata: { count: out.length }, req });
      return out;
    });
    cache.delByPrefix('doctors:');
    return created;
  }

  async function listSlots(doctorId, { from, to }) {
    const { rows } = await db.query(
      `SELECT id, start_time, end_time, status FROM availability_slots
       WHERE doctor_id = $1 AND start_time >= $2 AND start_time < $3
       ORDER BY start_time LIMIT 200`,
      [doctorId, from, to]
    );
    return rows;
  }

  return { search, addSlots, listSlots };
}

module.exports = { createDoctorsService };
