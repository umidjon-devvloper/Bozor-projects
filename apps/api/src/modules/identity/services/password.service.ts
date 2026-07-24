import bcrypt from 'bcrypt';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';

/**
 * A short list of passwords that appear in every credential-stuffing dump. In production this
 * is backed by a k-anonymity range query against a breach corpus; the local list is the
 * floor, not the ceiling (SECURITY.md).
 */
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123',
  'parol123', '11111111', '00000000', 'admin123', 'iloveyou', 'welcome1',
]);

export const passwordService = {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, env.BCRYPT_COST);
  },

  async verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  },

  /**
   * Runs a hash against a dummy value so that a login attempt for a non-existent phone takes
   * the same time as a real one. Without this, response timing reveals which numbers are
   * registered (AUTH.md).
   */
  async wasteTime(): Promise<void> {
    await bcrypt.compare('timing-equalisation', '$2b$12$1234567890123456789012uGZ9pTlY2mHkHqFq5NfP3rQ8vJz9K');
  },

  /** Rehash transparently when the configured cost changes. */
  needsRehash(hash: string): boolean {
    const rounds = bcrypt.getRounds(hash);
    return rounds < env.BCRYPT_COST;
  },

  assertStrong(plain: string, context: { phone?: string | undefined } = {}): void {
    const normalized = plain.toLowerCase();
    if (COMMON_PASSWORDS.has(normalized)) {
      throw new AppError(ErrorCode.AUTH_PASSWORD_WEAK, {
        detail: 'This password appears in known breach lists',
      });
    }
    if (context.phone) {
      const digits = context.phone.replace(/\D/g, '');
      if (digits.length >= 7 && plain.includes(digits.slice(-7))) {
        throw new AppError(ErrorCode.AUTH_PASSWORD_WEAK, {
          detail: 'Password must not contain your phone number',
        });
      }
    }
    if (/^(.)\1+$/.test(plain)) {
      throw new AppError(ErrorCode.AUTH_PASSWORD_WEAK, {
        detail: 'Password must not be a single repeated character',
      });
    }
  },
};
