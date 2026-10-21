// Seeds an admin, a verified doctor with open slots, and a patient for demos.
const bcrypt = require('bcryptjs');
const { createDb } = require('../src/db');

async function seed() {
  const db = createDb();
  const hash = await bcrypt.hash('Passw0rd!234', 12);
  const upsertUser = async (email, role, name) => {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [email, hash, role]
    );
    await db.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rows[0].id, name]);
    return rows[0].id;
  };

  await upsertUser('admin@amrutam.dev', 'admin', 'Admin');
  await upsertUser('patient@amrutam.dev', 'patient', 'Priya Patient');
  const doctorId = await upsertUser('doctor@amrutam.dev', 'doctor', 'Dr. Arjun Vaidya');
  await db.query(
    `INSERT INTO doctors (id, specialization, years_experience, fee_cents, languages, bio, rating, verified)
     VALUES ($1, 'Ayurveda', 12, 50000, '{english,hindi}', 'Panchakarma and digestive health', 4.8, TRUE)
     ON CONFLICT DO NOTHING`,
    [doctorId]
  );
  for (let i = 1; i <= 10; i++) {
    const start = new Date(Date.now() + i * 3600_000);
    start.setMinutes(0, 0, 0);
    await db.query(
      `INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [doctorId, start, new Date(start.getTime() + 30 * 60_000)]
    );
  }
  console.log('seeded: admin@amrutam.dev / doctor@amrutam.dev / patient@amrutam.dev (password Passw0rd!234)');
  await db.close();
}

seed().catch((e) => { console.error(e); process.exit(1); });
