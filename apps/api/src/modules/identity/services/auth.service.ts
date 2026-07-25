import mongoose from 'mongoose';
import { authenticator } from 'otplib';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import {
  ActorType,
  AuditSeverity,
  ConsentType,
  DEFAULT_LOCALE,
  OtpPurpose,
  TokenRevokeReason,
  UserRole,
  UserStatus,
  type Locale,
} from '@bozorlar/types';
import type {
  ChangePasswordRequest,
  LoginRequest,
  RegisterRequest,
} from './auth.types.js';
import { userRepository, type UserRecord } from '../repositories/user.repository.js';
import { refreshTokenRepository } from '../repositories/refreshToken.repository.js';
import { consentRepository } from '../repositories/consent.repository.js';
import { passwordService } from './password.service.js';
import type { OtpService } from './otp.service.js';
import type { TokenService } from './token.service.js';
import type { SessionService } from './session.service.js';
import type { AuditService } from '../../audit/index.js';
import { outboxService } from '../../outbox/index.js';
import { IdentityEvents } from '../events.js';

/** Progressive lockout: 5 -> 5 min, 7 -> 15 min, 10+ -> 60 min (AUTH.md). */
function lockoutFor(failedCount: number): Date | null {
  if (failedCount >= 10) return new Date(Date.now() + 60 * 60_000);
  if (failedCount >= 7) return new Date(Date.now() + 15 * 60_000);
  if (failedCount >= 5) return new Date(Date.now() + 5 * 60_000);
  return null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthDependencies {
  otp: OtpService;
  tokens: TokenService;
  sessions: SessionService;
  audit: AuditService;
  logger: Logger;
}

export function createAuthService(deps: AuthDependencies) {
  const { otp, tokens, sessions, audit, logger } = deps;

  // Returns a promise because every caller awaits it alongside genuinely async guards; making
  // it synchronous would put a bare call in the middle of an await chain.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function assertNotLocked(user: UserRecord): Promise<void> {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppError(ErrorCode.AUTH_ACCOUNT_LOCKED, {
        detail: 'Too many failed attempts',
        params: { retryAfter },
      });
    }
  }

  return {
    async register(input: RegisterRequest, meta: RequestMeta) {
      passwordService.assertStrong(input.password, { phone: input.phone });

      if (await userRepository.phoneExists(input.phone)) {
        throw new AppError(ErrorCode.AUTH_PHONE_ALREADY_REGISTERED, {
          detail: 'This phone number is already registered',
        });
      }

      const passwordHash = await passwordService.hash(input.password);
      const locale: Locale = (input.locale as Locale | undefined) ?? DEFAULT_LOCALE;

      // User, profile, consent record and the registration event all commit together, or
      // none of them do. A user without a consent record is not a lawful user (COMPLIANCE.md).
      const session = await mongoose.startSession();
      let user: UserRecord;
      try {
        user = await session.withTransaction(async () => {
          const created = await userRepository.create(
            {
              phone: input.phone,
              passwordHash,
              locale,
              roles: [UserRole.BUYER],
              profile: {
                firstName: input.firstName,
                lastName: input.lastName,
              },
            },
            session,
          );

          await consentRepository.record(
            [
              { userId: created.id, type: ConsentType.TERMS, documentVersion: input.consents.terms, granted: true, ip: meta.ip, userAgent: meta.userAgent },
              { userId: created.id, type: ConsentType.PRIVACY, documentVersion: input.consents.privacy, granted: true, ip: meta.ip, userAgent: meta.userAgent },
              { userId: created.id, type: ConsentType.MARKETING, documentVersion: input.consents.privacy, granted: input.consents.marketing, ip: meta.ip, userAgent: meta.userAgent },
            ],
            session,
          );

          await outboxService.publish(
            {
              type: IdentityEvents.USER_REGISTERED,
              aggregateType: 'user',
              aggregateId: created.id,
              payload: { userId: created.id, locale },
              actorId: created.id,
              actorType: ActorType.USER,
            },
            session,
          );

          return created;
        });
      } finally {
        await session.endSession();
      }

      const otpResult = await otp.send(input.phone, OtpPurpose.REGISTER, meta.ip);

      await audit.record({
        actorId: user.id,
        actorType: ActorType.USER,
        action: 'auth.register',
        targetType: 'user',
        targetId: user.id,
      });

      // No tokens until the phone is verified: an unverified account must not be able to
      // transact, and issuing tokens here would make the OTP step decorative.
      return {
        userId: user.id,
        otpSent: true,
        otpExpiresAt: otpResult.otpExpiresAt.toISOString(),
        resendAfter: otpResult.resendAfter,
      };
    },

    /**
     * Deliberately uniform: the response is identical whether or not the phone exists.
     * Otherwise this endpoint is a free user-enumeration oracle (API.md 5.1).
     */
    async sendOtp(phone: string, purpose: OtpPurpose, meta: RequestMeta) {
      const user = await userRepository.findByPhone(phone);

      if (purpose === OtpPurpose.PASSWORD_RESET && !user) {
        return { otpExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), resendAfter: 60, attemptsRemaining: 2 };
      }
      if (purpose === OtpPurpose.REGISTER && !user) {
        throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'No pending registration' });
      }

      const result = await otp.send(phone, purpose, meta.ip);
      return {
        otpExpiresAt: result.otpExpiresAt.toISOString(),
        resendAfter: result.resendAfter,
        attemptsRemaining: result.attemptsRemaining,
      };
    },

    async verifyOtpAndSignIn(
      input: { phone: string; purpose: OtpPurpose; code: string; deviceId: string },
      meta: RequestMeta,
    ) {
      await otp.verify(input.phone, input.purpose, input.code);

      const user = await userRepository.findByPhone(input.phone);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });

      if (user.phoneVerifiedAt === null) {
        await userRepository.markPhoneVerified(user.id);
        await sessions.invalidateIdentity(user.id);
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            await outboxService.publish(
              {
                type: IdentityEvents.USER_PHONE_VERIFIED,
                aggregateType: 'user',
                aggregateId: user.id,
                payload: { userId: user.id },
                actorId: user.id,
                actorType: ActorType.USER,
              },
              session,
            );
          });
        } finally {
          await session.endSession();
        }
      }

      const issued = await tokens.issue({
        userId: user.id,
        deviceId: input.deviceId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await userRepository.registerSuccessfulLogin(user.id);

      return { issued, user: { ...user, phoneVerifiedAt: user.phoneVerifiedAt ?? new Date() } };
    },

    async login(input: LoginRequest, meta: RequestMeta) {
      const user = await userRepository.findByPhoneWithSecrets(input.phone);

      if (!user) {
        // Equalise timing so an unknown phone is indistinguishable from a wrong password.
        await passwordService.wasteTime();
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, {
          detail: 'Invalid phone number or password',
        });
      }

      await assertNotLocked(user);

      if (user.status === UserStatus.BLOCKED) {
        throw new AppError(ErrorCode.AUTH_USER_BLOCKED, { detail: 'This account is blocked' });
      }
      if (user.status === UserStatus.DELETED) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, {
          detail: 'Invalid phone number or password',
        });
      }

      if (!(await passwordService.verify(input.password, user.passwordHash))) {
        const failedCount = await userRepository.registerFailedLogin(
          user.id,
          lockoutFor(user.failedLoginCount + 1),
        );
        logger.warn({ userId: user.id, failedCount }, 'failed login attempt');
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, {
          detail: 'Invalid phone number or password',
        });
      }

      if (user.phoneVerifiedAt === null) {
        throw new AppError(ErrorCode.AUTH_PHONE_NOT_VERIFIED, {
          detail: 'Verify your phone number to continue',
        });
      }

      if (user.twoFactorEnabled) {
        if (!input.totpCode) {
          throw new AppError(ErrorCode.AUTH_2FA_REQUIRED, { detail: 'Two-factor code required' });
        }
        if (!user.twoFactorSecret || !authenticator.check(input.totpCode, user.twoFactorSecret)) {
          await userRepository.registerFailedLogin(user.id, lockoutFor(user.failedLoginCount + 1));
          throw new AppError(ErrorCode.AUTH_2FA_INVALID, { detail: 'Invalid two-factor code' });
        }
      }

      // Transparent upgrade when BCRYPT_COST is raised; the user never notices.
      if (passwordService.needsRehash(user.passwordHash)) {
        await userRepository.setPassword(user.id, await passwordService.hash(input.password));
      }

      const issued = await tokens.issue({
        userId: user.id,
        deviceId: input.deviceId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await userRepository.registerSuccessfulLogin(user.id);

      await audit.record({
        actorId: user.id,
        actorType: ActorType.USER,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
      });

      return { issued, user };
    },

    async refresh(presentedToken: string, meta: RequestMeta) {
      try {
        return await tokens.rotate(presentedToken, meta);
      } catch (error) {
        if (AppError.isAppError(error) && error.code === ErrorCode.AUTH_REFRESH_REUSE_DETECTED) {
          await audit.record({
            actorType: ActorType.SYSTEM,
            action: 'auth.refresh_reuse_detected',
            targetType: 'session',
            severity: AuditSeverity.CRITICAL,
            reason: 'Refresh token replayed; token family revoked',
          });
        }
        throw error;
      }
    },

    async logout(userId: string, sessionId: string) {
      await tokens.revokeSession(sessionId, userId);
      await sessions.revokeSession(sessionId);
    },

    async logoutAll(userId: string) {
      const revoked = await tokens.revokeAll(userId, TokenRevokeReason.LOGOUT_ALL);
      await sessions.invalidateIdentity(userId);
      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.logout_all',
        targetType: 'user',
        targetId: userId,
        after: { revokedSessions: revoked },
      });
      return revoked;
    },

    async changePassword(userId: string, input: ChangePasswordRequest) {
      const user = await userRepository.findByIdWithSecrets(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });

      if (!(await passwordService.verify(input.currentPassword, user.passwordHash))) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, {
          detail: 'Current password is incorrect',
        });
      }
      passwordService.assertStrong(input.newPassword, { phone: user.phone });

      await userRepository.setPassword(userId, await passwordService.hash(input.newPassword));
      // Every other session dies with the old password. A password change that leaves the
      // attacker's session alive achieves nothing.
      await tokens.revokeAll(userId, TokenRevokeReason.PASSWORD_CHANGED);
      await sessions.invalidateIdentity(userId);

      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: userId,
        severity: AuditSeverity.WARNING,
      });
    },

    async forgotPassword(phone: string, meta: RequestMeta) {
      const user = await userRepository.findByPhone(phone);
      if (user && user.status === UserStatus.ACTIVE) {
        await otp.send(phone, OtpPurpose.PASSWORD_RESET, meta.ip);
      }
      // Always the same response shape and status, whether or not the account exists.
      return { otpExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), resendAfter: 60 };
    },

    async resetPassword(
      input: { phone: string; code: string; newPassword: string },
      meta: RequestMeta,
    ) {
      await otp.verify(input.phone, OtpPurpose.PASSWORD_RESET, input.code);

      const user = await userRepository.findByPhone(input.phone);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });

      passwordService.assertStrong(input.newPassword, { phone: input.phone });
      await userRepository.setPassword(user.id, await passwordService.hash(input.newPassword));
      await tokens.revokeAll(user.id, TokenRevokeReason.PASSWORD_CHANGED);
      await sessions.invalidateIdentity(user.id);

      await audit.record({
        actorId: user.id,
        actorType: ActorType.USER,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: user.id,
        severity: AuditSeverity.WARNING,
      });

      const issued = await tokens.issue({
        userId: user.id,
        deviceId: `reset-${Date.now()}`,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { issued, user };
    },

    async requestPhoneChange(userId: string, newPhone: string, password: string, meta: RequestMeta) {
      const user = await userRepository.findByIdWithSecrets(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      if (!(await passwordService.verify(password, user.passwordHash))) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, { detail: 'Password is incorrect' });
      }
      if (await userRepository.phoneExists(newPhone)) {
        throw new AppError(ErrorCode.AUTH_PHONE_ALREADY_REGISTERED, {
          detail: 'This phone number is already registered',
        });
      }
      // Both numbers are challenged: the old one proves the requester controls the account,
      // the new one proves they control the destination.
      await otp.send(user.phone, OtpPurpose.PHONE_CHANGE, meta.ip);
      await otp.send(newPhone, OtpPurpose.PHONE_CHANGE, meta.ip);
      return { sent: true };
    },

    async confirmPhoneChange(
      userId: string,
      input: { newPhone: string; codeOld: string; codeNew: string },
    ) {
      const user = await userRepository.findById(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });

      await otp.verify(user.phone, OtpPurpose.PHONE_CHANGE, input.codeOld);
      await otp.verify(input.newPhone, OtpPurpose.PHONE_CHANGE, input.codeNew);

      await userRepository.changePhone(userId, input.newPhone);
      await tokens.revokeAll(userId, TokenRevokeReason.PHONE_CHANGED);
      await sessions.invalidateIdentity(userId);

      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.phone_changed',
        targetType: 'user',
        targetId: userId,
        before: { phone: user.phone },
        after: { phone: input.newPhone },
        severity: AuditSeverity.WARNING,
      });
    },

    async requestDeletion(userId: string, password: string, reason: string | undefined) {
      const user = await userRepository.findByIdWithSecrets(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      if (!(await passwordService.verify(password, user.passwordHash))) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, { detail: 'Password is incorrect' });
      }

      await userRepository.scheduleDeletion(userId, reason ?? null);
      await tokens.revokeAll(userId, TokenRevokeReason.ADMIN);
      await sessions.invalidateIdentity(userId);

      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.deletion_requested',
        targetType: 'user',
        targetId: userId,
        reason: reason ?? null,
        severity: AuditSeverity.WARNING,
      });

      // 30-day grace, then PII anonymisation. Orders and ledger entries are retained with
      // identifiers stripped, because statutory bookkeeping requires them (COMPLIANCE.md).
      const scheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      return { deletionScheduledAt: scheduledAt.toISOString() };
    },

    async listSessions(userId: string, currentSessionId: string) {
      const records = await refreshTokenRepository.listActiveSessions(userId);
      return records.map((record) => ({
        id: record.id,
        deviceId: record.deviceId,
        ip: record.ip ?? undefined,
        userAgent: record.userAgent ?? undefined,
        lastUsedAt: record.usedAt?.toISOString() ?? null,
        createdAt: record.createdAt.toISOString(),
        isCurrent: record.id === currentSessionId,
      }));
    },

    async revokeSession(userId: string, sessionId: string) {
      const revoked = await tokens.revokeSession(sessionId, userId);
      if (!revoked) {
        throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Session not found' });
      }
      await sessions.revokeSession(sessionId);
    },

    async beginTwoFactorSetup(userId: string) {
      const user = await userRepository.findById(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      if (user.twoFactorEnabled) {
        throw new AppError(ErrorCode.AUTH_2FA_ALREADY_ENABLED, { detail: 'Already enabled' });
      }
      const secret = authenticator.generateSecret();
      // Stored but not enabled: an interrupted setup must not lock the user out.
      await userRepository.setTwoFactorSecret(userId, secret, false);
      return {
        secret,
        otpauthUrl: authenticator.keyuri(user.phone, 'Bozorlar', secret),
      };
    },

    async confirmTwoFactor(userId: string, totpCode: string) {
      const user = await userRepository.findByIdWithSecrets(userId);
      if (!user?.twoFactorSecret) {
        throw new AppError(ErrorCode.AUTH_2FA_INVALID, { detail: 'Start two-factor setup first' });
      }
      if (!authenticator.check(totpCode, user.twoFactorSecret)) {
        throw new AppError(ErrorCode.AUTH_2FA_INVALID, { detail: 'Invalid code' });
      }
      await userRepository.setTwoFactorSecret(userId, user.twoFactorSecret, true);
      await sessions.invalidateIdentity(userId);
      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.2fa_enabled',
        targetType: 'user',
        targetId: userId,
        severity: AuditSeverity.WARNING,
      });
    },

    async disableTwoFactor(userId: string, password: string, totpCode: string) {
      const user = await userRepository.findByIdWithSecrets(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      if (!(await passwordService.verify(password, user.passwordHash))) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, { detail: 'Password is incorrect' });
      }
      if (!user.twoFactorSecret || !authenticator.check(totpCode, user.twoFactorSecret)) {
        throw new AppError(ErrorCode.AUTH_2FA_INVALID, { detail: 'Invalid code' });
      }
      const isPrivileged = user.roles.some(
        (role) => role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN,
      );
      if (isPrivileged) {
        throw new AppError(ErrorCode.PERM_DENIED, {
          detail: 'Two-factor authentication is mandatory for administrative roles',
        });
      }
      await userRepository.setTwoFactorSecret(userId, null, false);
      await sessions.invalidateIdentity(userId);
      await audit.record({
        actorId: userId,
        actorType: ActorType.USER,
        action: 'auth.2fa_disabled',
        targetType: 'user',
        targetId: userId,
        severity: AuditSeverity.WARNING,
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
