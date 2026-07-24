import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import type { OtpPurpose } from '@bozorlar/types';
import { otpRepository } from '../repositories/otp.repository.js';
import type { SmsProvider } from './sms.service.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 3;
const RESEND_COOLDOWN_SECONDS = 60;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export interface OtpSendResult {
  otpExpiresAt: Date;
  resendAfter: number;
  attemptsRemaining: number;
}

export function createOtpService(sms: SmsProvider, logger: Logger) {
  return {
    async send(
      identifier: string,
      purpose: OtpPurpose,
      ip: string | null,
    ): Promise<OtpSendResult> {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const sentInLastHour = await otpRepository.countSentSince(identifier, hourAgo);
      if (sentInLastHour >= MAX_SENDS_PER_HOUR) {
        throw new AppError(ErrorCode.OTP_SEND_RATE_LIMITED, {
          detail: `Maximum ${MAX_SENDS_PER_HOUR} codes per hour`,
          params: { retryAfter: 3600 },
        });
      }

      const existing = await otpRepository.findActive(identifier, purpose);
      if (existing) {
        const elapsed = (Date.now() - existing.createdAt.getTime()) / 1000;
        if (elapsed < RESEND_COOLDOWN_SECONDS) {
          throw new AppError(ErrorCode.OTP_SEND_RATE_LIMITED, {
            detail: 'A code was sent recently',
            params: { retryAfter: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed) },
          });
        }
        // Only one code may be live at a time, or a user with three unexpired codes has
        // three times the guessing surface.
        await otpRepository.invalidateAll(identifier, purpose);
      }

      // randomInt is CSPRNG-backed; Math.random is not, and a predictable OTP is no OTP.
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await otpRepository.create({ identifier, purpose, codeHash: hashCode(code), expiresAt, ip });

      try {
        await sms.send(identifier, `Bozorlar tasdiqlash kodi: ${code}. Hech kimga aytmang.`);
      } catch (cause) {
        logger.error({ err: cause, purpose }, 'otp delivery failed');
        throw new AppError(ErrorCode.OTP_DELIVERY_FAILED, {
          detail: 'Could not deliver the verification code',
          cause,
        });
      }

      return {
        otpExpiresAt: expiresAt,
        resendAfter: RESEND_COOLDOWN_SECONDS,
        attemptsRemaining: MAX_SENDS_PER_HOUR - sentInLastHour - 1,
      };
    },

    async verify(identifier: string, purpose: OtpPurpose, code: string): Promise<void> {
      const record = await otpRepository.findActive(identifier, purpose);
      if (!record) throw new AppError(ErrorCode.OTP_INVALID, { detail: 'No active code' });

      if (record.expiresAt.getTime() < Date.now()) {
        throw new AppError(ErrorCode.OTP_EXPIRED, { detail: 'The code has expired' });
      }
      if (record.attempts >= MAX_ATTEMPTS) {
        throw new AppError(ErrorCode.OTP_TOO_MANY_ATTEMPTS, {
          detail: 'Too many incorrect attempts; request a new code',
        });
      }

      if (!constantTimeEquals(hashCode(code), record.codeHash)) {
        const attempts = await otpRepository.incrementAttempts(record.id);
        if (attempts >= MAX_ATTEMPTS) {
          await otpRepository.invalidateAll(identifier, purpose);
          throw new AppError(ErrorCode.OTP_TOO_MANY_ATTEMPTS, {
            detail: 'Too many incorrect attempts; request a new code',
          });
        }
        throw new AppError(ErrorCode.OTP_INVALID, {
          detail: 'Incorrect code',
          params: { attemptsRemaining: MAX_ATTEMPTS - attempts },
        });
      }

      if (!(await otpRepository.consume(record.id))) {
        // Lost the race against a concurrent verification of the same code.
        throw new AppError(ErrorCode.OTP_ALREADY_USED, { detail: 'This code has already been used' });
      }
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;
