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
  const doctors = [
    ['doctor@amrutam.dev', 'Dr. Arjun Vaidya', 'Ayurveda', 12, 50000, '{english,hindi}', 'Panchakarma and digestive health', 4.8],
    ['meera@amrutam.dev', 'Dr. Meera Nair', 'Dermatology', 8, 60000, '{english,malayalam}', 'Ayurvedic skin and hair care', 4.7],
    ['rohan@amrutam.dev', 'Dr. Rohan Sharma', 'General Physician', 15, 30000, '{english,hindi}', 'Lifestyle disorders, diabetes, BP', 4.6],
    ['kavya@amrutam.dev', 'Dr. Kavya Iyer', 'Gynecology', 10, 70000, '{english,tamil}', "Women's health and PCOS", 4.9],
    ['sameer@amrutam.dev', 'Dr. Sameer Khan', 'Nutrition', 6, 25000, '{english,hindi,urdu}', 'Diet plans and weight management', 4.5],
  ];
  for (const [email, name, spec, years, fee, langs, bio, rating] of doctors) {
    const doctorId = await upsertUser(email, 'doctor', name);
    await db.query(
      `INSERT INTO doctors (id, specialization, years_experience, fee_cents, languages, bio, rating, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) ON CONFLICT DO NOTHING`,
      [doctorId, spec, years, fee, langs, bio, rating]
    );
    // Open 30-min slots over the next 3 days, 10:00-13:00 local server time.
    for (let day = 1; day <= 3; day++) {
      for (let h = 0; h < 6; h++) {
        const start = new Date();
        start.setDate(start.getDate() + day);
        start.setHours(10, h * 30, 0, 0);
        await db.query(
          `INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [doctorId, start, new Date(start.getTime() + 30 * 60_000)]
        );
      }
    }
  }
  console.log('seeded: admin@amrutam.dev, patient@amrutam.dev, 5 doctors (doctor@amrutam.dev, ...) - password Passw0rd!234');
  await db.close();
}

seed().catch((e) => { console.error(e); process.exit(1); });
