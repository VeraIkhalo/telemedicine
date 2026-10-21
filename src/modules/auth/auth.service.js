const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { signToken } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { unauthorized, badRequest, conflict } = require('../../lib/errors');

function createAuthService({ db, cipher }) {
  async function register({ email, password, fullName, phone, role, doctor }, req) {
    const passwordHash = await bcrypt.hash(password, 12);
    return db.tx(async (c) => {
      const existing = await c.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (existing.rowCount) throw conflict('Email already registered');
      const { rows } = await c.query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
        [email, passwordHash, role]
      );
      const user = rows[0];
      await c.query('INSERT INTO profiles (user_id, full_name, phone) VALUES ($1, $2, $3)', [user.id, fullName, phone || null]);
      if (role === 'doctor') {
        await c.query(
          `INSERT INTO doctors (id, specialization, years_experience, fee_cents, languages, bio)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [user.id, doctor.specialization, doctor.yearsExperience, doctor.feeCents, doctor.languages, doctor.bio || null]
        );
      }
      await audit(c, { actorId: user.id, action: 'user.register', entity: 'user', entityId: user.id, metadata: { role }, req });
      return user;
    });
  }

  async function login({ email, password, totp }, req) {
    const { rows } = await db.query(
      'SELECT id, role, password_hash, mfa_enabled, mfa_secret, is_active FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Same error for unknown email / wrong password: prevents user enumeration.
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      await audit(db, { actorId: user?.id, action: 'auth.login_failed', entity: 'user', entityId: user?.id, req });
      throw unauthorized('Invalid credentials');
    }
    if (user.mfa_enabled) {
      if (!totp) return { mfaRequired: true };
      if (!authenticator.check(totp, cipher.decrypt(user.mfa_secret))) {
        await audit(db, { actorId: user.id, action: 'auth.mfa_failed', entity: 'user', entityId: user.id, req });
        throw unauthorized('Invalid MFA code');
      }
    }
    const { rows: s } = await db.query(
      `INSERT INTO sessions (user_id, expires_at, ip, user_agent)
       VALUES ($1, now() + interval '1 day', $2, $3) RETURNING id`,
      [user.id, req?.ip || null, req?.get?.('user-agent')?.slice(0, 300) || null]
    );
    await audit(db, { actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, req });
    return { accessToken: signToken(user, s[0].id), tokenType: 'Bearer', role: user.role };
  }

  // Ends the session server-side: the token stops working immediately, in every tab/tool.
  async function logout(user, req) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [user.sid, user.id]);
    await audit(db, { actorId: user.id, action: 'auth.logout', entity: 'user', entityId: user.id, req });
    return { loggedOut: true };
  }

  async function setupMfa(userId) {
    const secret = authenticator.generateSecret();
    await db.query('UPDATE users SET mfa_secret = $2, mfa_enabled = FALSE, updated_at = now() WHERE id = $1', [
      userId,
      cipher.encrypt(secret),
    ]);
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    return { secret, otpauthUrl: authenticator.keyuri(rows[0].email, 'Amrutam', secret) };
  }

  async function enableMfa(userId, totp, req) {
    const { rows } = await db.query('SELECT mfa_secret FROM users WHERE id = $1', [userId]);
    if (!rows[0]?.mfa_secret) throw badRequest('Call /auth/mfa/setup first');
    if (!authenticator.check(totp, cipher.decrypt(rows[0].mfa_secret))) throw badRequest('Invalid MFA code');
    await db.query('UPDATE users SET mfa_enabled = TRUE, updated_at = now() WHERE id = $1', [userId]);
    await audit(db, { actorId: userId, action: 'auth.mfa_enabled', entity: 'user', entityId: userId, req });
    return { mfaEnabled: true };
  }

  async function me(userId) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.role, u.mfa_enabled, p.full_name, p.phone
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [userId]
    );
    return rows[0];
  }

  return { register, login, logout, setupMfa, enableMfa, me };
}

module.exports = { createAuthService };
