import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { OtpPurpose } from '@bozorlar/types';
import { sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import type { AuthService, RequestMeta } from '../services/auth.service.js';
import { userRepository } from '../repositories/user.repository.js';
import { deviceRepository } from '../repositories/device.repository.js';
import { toPublicUser } from './mappers.js';
import { clearAuthCookies, cookieNames, setAuthCookies } from './cookies.js';

/** Mobile clients read the refresh token from the body; web clients only ever see cookies. */
const isWebClient = (req: Request): boolean => req.header('x-client') === 'web';

function meta(req: Request): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

export function createAuthController(auth: AuthService) {
  async function respondWithSession(
    req: Request,
    res: Response,
    issued: { accessToken: string; refreshToken: string; expiresIn: number },
    userId: string,
    status = 200,
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
    const profile = await userRepository.getProfile(userId);

    const body = {
      accessToken: issued.accessToken,
      expiresIn: issued.expiresIn,
      tokenType: 'Bearer' as const,
      ...(isWebClient(req) ? {} : { refreshToken: issued.refreshToken }),
      user: toPublicUser(user, profile, { isSelf: true }),
    };

    if (isWebClient(req)) setAuthCookies(res, issued.accessToken, issued.refreshToken);
    sendData(res, body, status);
  }

  return {
    async register(req: Request, res: Response): Promise<void> {
      const result = await auth.register(req.body as never, meta(req));
      sendCreated(res, result);
    },

    async sendOtp(req: Request, res: Response): Promise<void> {
      const { phone, purpose } = req.body as { phone: string; purpose: OtpPurpose };
      sendData(res, await auth.sendOtp(phone, purpose, meta(req)));
    },

    async verifyOtp(req: Request, res: Response): Promise<void> {
      const input = req.body as {
        phone: string;
        purpose: OtpPurpose;
        code: string;
        deviceId: string;
      };
      const { issued, user } = await auth.verifyOtpAndSignIn(input, meta(req));
      await respondWithSession(req, res, issued, user.id);
    },

    async login(req: Request, res: Response): Promise<void> {
      const { issued, user } = await auth.login(req.body as never, meta(req));
      await respondWithSession(req, res, issued, user.id);
    },

    async refresh(req: Request, res: Response): Promise<void> {
      const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
      const cookieToken = (req.cookies as Record<string, string> | undefined)?.[cookieNames.refresh];
      const presented = bodyToken ?? cookieToken;
      if (!presented) {
        throw new AppError(ErrorCode.AUTH_REFRESH_INVALID, { detail: 'No refresh token provided' });
      }

      const rotated = await auth.refresh(presented, meta(req));
      const body = {
        accessToken: rotated.accessToken,
        expiresIn: rotated.expiresIn,
        tokenType: 'Bearer' as const,
        ...(isWebClient(req) ? {} : { refreshToken: rotated.refreshToken }),
      };
      if (isWebClient(req)) setAuthCookies(res, rotated.accessToken, rotated.refreshToken);
      sendData(res, body);
    },

    async logout(req: Request, res: Response): Promise<void> {
      const { userId, sessionId } = requireAuth(req);
      await auth.logout(userId, sessionId);
      clearAuthCookies(res);
      sendNoContent(res);
    },

    async logoutAll(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      await auth.logoutAll(userId);
      clearAuthCookies(res);
      sendNoContent(res);
    },

    async me(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const user = await userRepository.findById(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      const profile = await userRepository.getProfile(userId);
      sendData(res, toPublicUser(user, profile, { isSelf: true }));
    },

    async updateMe(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const patch = req.body as {
        firstName?: string;
        lastName?: string;
        locale?: string;
        defaultRegionId?: string;
        defaultDistrictId?: string;
      };

      const { locale, ...profilePatch } = patch;
      if (Object.keys(profilePatch).length > 0) {
        await userRepository.updateProfile(userId, profilePatch);
      }
      if (locale) await userRepository.updateLocale(userId, locale as never);

      const user = await userRepository.findById(userId);
      if (!user) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'User not found' });
      sendData(res, toPublicUser(user, await userRepository.getProfile(userId), { isSelf: true }));
    },

    async changePassword(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      await auth.changePassword(userId, req.body as never);
      clearAuthCookies(res);
      sendNoContent(res);
    },

    async forgotPassword(req: Request, res: Response): Promise<void> {
      const { phone } = req.body as { phone: string };
      sendData(res, await auth.forgotPassword(phone, meta(req)));
    },

    async resetPassword(req: Request, res: Response): Promise<void> {
      const input = req.body as { phone: string; code: string; newPassword: string };
      const { issued, user } = await auth.resetPassword(input, meta(req));
      await respondWithSession(req, res, issued, user.id);
    },

    async requestPhoneChange(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const { newPhone, password } = req.body as { newPhone: string; password: string };
      sendData(res, await auth.requestPhoneChange(userId, newPhone, password, meta(req)));
    },

    async confirmPhoneChange(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      await auth.confirmPhoneChange(userId, req.body as never);
      clearAuthCookies(res);
      sendNoContent(res);
    },

    async deleteAccount(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const { password, reason } = req.body as { password: string; reason?: string };
      const result = await auth.requestDeletion(userId, password, reason);
      clearAuthCookies(res);
      sendData(res, result, 202);
    },

    async listSessions(req: Request, res: Response): Promise<void> {
      const { userId, sessionId } = requireAuth(req);
      sendData(res, await auth.listSessions(userId, sessionId));
    },

    async revokeSession(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const sessionId = req.params.id;
      if (!sessionId) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Session not found' });
      await auth.revokeSession(userId, sessionId);
      sendNoContent(res);
    },

    async beginTwoFactor(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      sendData(res, await auth.beginTwoFactorSetup(userId));
    },

    async confirmTwoFactor(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const { totpCode } = req.body as { totpCode: string };
      await auth.confirmTwoFactor(userId, totpCode);
      sendNoContent(res);
    },

    async disableTwoFactor(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const { password, totpCode } = req.body as { password: string; totpCode: string };
      await auth.disableTwoFactor(userId, password, totpCode);
      sendNoContent(res);
    },

    async registerDevice(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const input = req.body as Parameters<typeof deviceRepository.upsert>[0];
      sendData(res, await deviceRepository.upsert({ ...input, userId }));
    },

    async updateDevice(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const deviceId = req.params.deviceId;
      if (!deviceId) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Device not found' });
      const updated = await deviceRepository.update(userId, deviceId, req.body as never);
      if (!updated) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Device not found' });
      sendData(res, updated);
    },

    async removeDevice(req: Request, res: Response): Promise<void> {
      const { userId } = requireAuth(req);
      const deviceId = req.params.deviceId;
      if (!deviceId) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: 'Device not found' });
      await deviceRepository.remove(userId, deviceId);
      sendNoContent(res);
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
