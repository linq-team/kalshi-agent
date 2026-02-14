import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

const ENCRYPTION_KEY_HEX = process.env.CREDENTIAL_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY_HEX) {
  console.warn('[auth] CREDENTIAL_ENCRYPTION_KEY not set — credentials stored as plaintext (dev only)');
  console.warn('[auth] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

function getEncryptionKey(): Buffer | null {
  if (!ENCRYPTION_KEY_HEX) return null;

  const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars)`);
  }

  return key;
}

/**
 * Encrypt an object as JSON. Returns base64 string: iv:authTag:ciphertext
 * Falls back to base64-encoded plaintext JSON if no encryption key is set.
 */
export function encrypt(data: object): string {
  const key = getEncryptionKey();

  if (!key) {
    // Dev fallback: base64 JSON with "plain:" prefix so decrypt knows
    return `plain:${Buffer.from(JSON.stringify(data)).toString('base64')}`;
  }

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a string created by encrypt() and return the original object.
 */
export function decrypt(encryptedString: string): object {
  // Dev fallback
  if (encryptedString.startsWith('plain:')) {
    return JSON.parse(Buffer.from(encryptedString.slice(6), 'base64').toString('utf8'));
  }

  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Cannot decrypt: CREDENTIAL_ENCRYPTION_KEY not set');
  }

  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}
