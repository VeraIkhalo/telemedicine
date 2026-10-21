// Field-level encryption (AES-256-GCM) with key versioning for rotation.
// Ciphertext format: "<keyVersion>:<iv b64>:<tag b64>:<data b64>"
const crypto = require('crypto');

function parseKeys(spec) {
  const keys = new Map();
  let active;
  for (const part of spec.split(',')) {
    const [version, b64] = part.trim().split(':');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key ${version} must be 32 bytes`);
    keys.set(version, key);
    if (!active) active = version;
  }
  return { keys, active };
}

function createCipher(spec) {
  const { keys, active } = parseKeys(spec);

  function encrypt(plaintext) {
    if (plaintext == null) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(active), iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [active, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  function decrypt(payload) {
    if (payload == null) return null;
    const [version, iv, tag, data] = payload.split(':');
    const key = keys.get(version);
    if (!key) throw new Error(`Unknown key version ${version}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  // True when the value was encrypted with an old key and should be re-encrypted.
  const needsRotation = (payload) => payload != null && !payload.startsWith(active + ':');

  return { encrypt, decrypt, needsRotation };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { createCipher, sha256 };
