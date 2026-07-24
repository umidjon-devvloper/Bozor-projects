import { Router, type RequestHandler } from 'express';
import {
  ChangePasswordRequestSchema,
  DeleteAccountRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  OtpSendRequestSchema,
  OtpVerifyRequestSchema,
  PhoneChangeConfirmSchema,
  PhoneChangeRequestSchema,
  RefreshRequestSchema,
  RegisterDeviceRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  TwoFactorConfirmRequestSchema,
  TwoFactorDisableRequestSchema,
  UpdateDeviceRequestSchema,
  UpdateMeRequestSchema,
} from '@bozorlar/contracts';
import { validateBody } from '../../../middleware/validate.js';
import { byIpAndPhone, byUser, rateLimit } from '../../../middleware/rateLimit.js';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import type { AuthController } from './auth.controller.js';

/**
 * Route definitions. Rate limits mirror API.md Part 7 and are attached here rather than in a
 * global table so that a route and its limit are reviewed together.
 */
export function createAuthRouter(controller: AuthController, authenticate: RequestHandler): Router {
  const router = Router();

  // --- public ---
  router.post(
    '/register',
    rateLimit({ name: 'auth:register', limit: 5, windowSeconds: 900, keyResolver: byIpAndPhone }),
    validateBody(RegisterRequestSchema),
    asyncHandler(controller.register),
  );

  router.post(
    '/otp/send',
    rateLimit({ name: 'auth:otp', limit: 10, windowSeconds: 3600, keyResolver: byIpAndPhone }),
    validateBody(OtpSendRequestSchema),
    asyncHandler(controller.sendOtp),
  );

  router.post(
    '/otp/verify',
    rateLimit({ name: 'auth:otp-verify', limit: 10, windowSeconds: 900, keyResolver: byIpAndPhone }),
    validateBody(OtpVerifyRequestSchema),
    asyncHandler(controller.verifyOtp),
  );

  router.post(
    '/login',
    rateLimit({ name: 'auth:login', limit: 5, windowSeconds: 900, keyResolver: byIpAndPhone }),
    validateBody(LoginRequestSchema),
    asyncHandler(controller.login),
  );

  router.post(
    '/refresh',
    rateLimit({ name: 'auth:refresh', limit: 60, windowSeconds: 900 }),
    validateBody(RefreshRequestSchema),
    asyncHandler(controller.refresh),
  );

  router.post(
    '/password/forgot',
    rateLimit({ name: 'auth:forgot', limit: 5, windowSeconds: 3600, keyResolver: byIpAndPhone }),
    validateBody(ForgotPasswordRequestSchema),
    asyncHandler(controller.forgotPassword),
  );

  router.post(
    '/password/reset',
    rateLimit({ name: 'auth:reset', limit: 5, windowSeconds: 3600, keyResolver: byIpAndPhone }),
    validateBody(ResetPasswordRequestSchema),
    asyncHandler(controller.resetPassword),
  );

  // --- authenticated ---
  router.use(authenticate);
  const limited = rateLimit({ name: 'auth:authed', limit: 300, windowSeconds: 60, keyResolver: byUser });

  router.post('/logout', limited, asyncHandler(controller.logout));
  router.post('/logout-all', limited, asyncHandler(controller.logoutAll));

  router.get('/me', limited, asyncHandler(controller.me));
  router.patch('/me', limited, validateBody(UpdateMeRequestSchema), asyncHandler(controller.updateMe));
  router.delete(
    '/me',
    limited,
    validateBody(DeleteAccountRequestSchema),
    asyncHandler(controller.deleteAccount),
  );

  router.post(
    '/password/change',
    rateLimit({ name: 'auth:change-pw', limit: 5, windowSeconds: 3600, keyResolver: byUser }),
    validateBody(ChangePasswordRequestSchema),
    asyncHandler(controller.changePassword),
  );

  router.post(
    '/phone/change/request',
    rateLimit({ name: 'auth:phone-change', limit: 3, windowSeconds: 3600, keyResolver: byUser }),
    validateBody(PhoneChangeRequestSchema),
    asyncHandler(controller.requestPhoneChange),
  );
  router.post(
    '/phone/change/confirm',
    rateLimit({ name: 'auth:phone-confirm', limit: 5, windowSeconds: 3600, keyResolver: byUser }),
    validateBody(PhoneChangeConfirmSchema),
    asyncHandler(controller.confirmPhoneChange),
  );

  router.get('/sessions', limited, asyncHandler(controller.listSessions));
  router.delete('/sessions/:id', limited, asyncHandler(controller.revokeSession));

  router.post('/2fa/enable', limited, asyncHandler(controller.beginTwoFactor));
  router.post(
    '/2fa/confirm',
    limited,
    validateBody(TwoFactorConfirmRequestSchema),
    asyncHandler(controller.confirmTwoFactor),
  );
  router.post(
    '/2fa/disable',
    limited,
    validateBody(TwoFactorDisableRequestSchema),
    asyncHandler(controller.disableTwoFactor),
  );

  return router;
}

export function createDeviceRouter(controller: AuthController, authenticate: RequestHandler): Router {
  const router = Router();
  router.use(authenticate);
  const limited = rateLimit({ name: 'devices', limit: 60, windowSeconds: 60, keyResolver: byUser });

  router.post('/', limited, validateBody(RegisterDeviceRequestSchema), asyncHandler(controller.registerDevice));
  router.patch('/:deviceId', limited, validateBody(UpdateDeviceRequestSchema), asyncHandler(controller.updateDevice));
  router.delete('/:deviceId', limited, asyncHandler(controller.removeDevice));
  return router;
}
