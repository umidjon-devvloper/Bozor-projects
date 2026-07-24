import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@bozorlar/config';
import { AppError, ErrorCode } from '@bozorlar/errors';

/**
 * Field-level encryption for personal data (SECURITY.md "Data protection").
 *
 * Passport series and number are the most sensitive values this system stores: they are
 * identity documents, they never change, and a leak is permanent. They are encrypted with
 * AES-256-GCM so that a database dump — or a backup restored to the wrong place — yields
 * ciphertext rather than identities.
 *
 * Two independent keys are derived from the configured secret via HKDF-SHA256 with distinct
 * `info` labels. Domain separation matters: the cursor signer already uses the same secret,
 * and reusing one key across an HMAC and a cipher is how key material leaks between
 * unrelated features.
 */

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const CURRENT_VERSION = 'v1';

function deriveKey(label: string): Buffer {
  // The salt is fixed and public; HKDF's security here rests on the secret, and a stable
  // salt is what makes derivation deterministic across restarts and instances.
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(env.PII_ENCRYPTION_KEY, 'utf8'), Buffer.from('bozorlar-pii-v1'), Buffer.from(label), KEY_LENGTH),
  );
}

let encryptionKey: Buffer | null = null;
let blindIndexKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  encryptionKey ??= deriveKey('field-encryption');
  return encryptionKey;
}

function getBlindIndexKey(): Buffer {
  blindIndexKey ??= deriveKey('blind-index');
  return blindIndexKey;
}

/**
 * Encrypts a value into a self-describing envelope.
 *
 * Format: `v1:<iv>:<authTag>:<ciphertext>`, all base64url. The version prefix is what makes
 * key rotation possible later without a flag day: a future `v2` can be written while `v1`
 * remains readable.
 */
export function encryptField(plaintext: string): string {
  if (plaintext.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { detail: 'Cannot encrypt an empty value' });
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    CURRENT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypts an envelope.
 *
 * GCM authenticates as well as encrypts, so a tampered ciphertext fails here rather than
 * returning plausible-looking garbage. That failure is treated as an internal error, not a
 * validation error: it means the stored data or the key is wrong, which is an operational
 * incident and not something a caller can fix.
 */
export function decryptField(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, {
      detail: 'Encrypted field is malformed',
    });
  }
  const [version, ivPart, tagPart, dataPart] = parts;
  if (version !== CURRENT_VERSION) {
    throw new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, {
      detail: `Unsupported encrypted field version "${String(version)}"`,
    });
  }

  try {
    const iv = Buffer.from(ivPart ?? '', 'base64url');
    const tag = Buffer.from(tagPart ?? '', 'base64url');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error('bad envelope geometry');
    }
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, {
      detail: 'Encrypted field could not be decrypted',
      cause,
    });
  }
}

export function isEncrypted(value: string): boolean {
  return /^v\d+:[\w-]+:[\w-]+:[\w-]+$/.test(value);
}

/**
 * Deterministic blind index for equality lookups on encrypted data.
 *
 * Encrypted fields cannot be indexed — every ciphertext of the same value differs, by design.
 * To answer "has this passport already been used?" without decrypting the whole collection,
 * a keyed HMAC of the normalised value is stored alongside and uniquely indexed.
 *
 * Known limitation, stated plainly: the input space is small (a 9-digit STIR is 10^9), so an
 * attacker holding *both* the database and the blind-index key can enumerate it offline. The
 * mitigation is operational rather than algorithmic — the key is derived from a secret that
 * lives in the vault, never in the database or on the database host, and it is separate from
 * the encryption key so compromising one does not yield the other.
 */
export function blindIndex(value: string): string {
  const normalised = value.trim().toUpperCase().replace(/\s+/g, '');
  if (normalised.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: 'Cannot compute a blind index for an empty value',
    });
  }
  return createHmac('sha256', getBlindIndexKey()).update(normalised, 'utf8').digest('hex');
}

/** Compares two blind indexes without leaking position information through timing. */
export function blindIndexEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/** Redacts a value for display: `AA1234567` becomes `AA***4567`. */
export function maskDocumentNumber(value: string): string {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}
