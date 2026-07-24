import { z } from 'zod';
import { OtpPurpose, Platform } from '@bozorlar/types';
import {
  DeviceIdSchema,
  LocaleSchema,
  ObjectIdSchema,
  OtpCodeSchema,
  PasswordSchema,
  PhoneSchema,
} from '../common/primitives.js';

const NameSchema = z.string().trim().min(1).max(50);

export const ConsentsSchema = z.object({
  terms: z.string().min(1),
  privacy: z.string().min(1),
  marketing: z.boolean().default(false),
});

export const RegisterRequestSchema = z
  .object({
    phone: PhoneSchema,
    password: PasswordSchema,
    firstName: NameSchema,
    lastName: NameSchema.optional(),
    locale: LocaleSchema.optional(),
    consents: ConsentsSchema,
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  userId: ObjectIdSchema,
  otpSent: z.boolean(),
  otpExpiresAt: z.string().datetime(),
  resendAfter: z.number().int(),
});

export const OtpSendRequestSchema = z
  .object({ phone: PhoneSchema, purpose: z.nativeEnum(OtpPurpose) })
  .strict();

export const OtpSendResponseSchema = z.object({
  otpExpiresAt: z.string().datetime(),
  resendAfter: z.number().int(),
  attemptsRemaining: z.number().int(),
});

export const OtpVerifyRequestSchema = z
  .object({
    phone: PhoneSchema,
    purpose: z.nativeEnum(OtpPurpose),
    code: OtpCodeSchema,
    deviceId: DeviceIdSchema,
  })
  .strict();

export const LoginRequestSchema = z
  .object({
    phone: PhoneSchema,
    password: z.string().min(1).max(128),
    deviceId: DeviceIdSchema,
    totpCode: OtpCodeSchema.optional(),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(32).max(256).optional() })
  .strict();

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().int(),
  tokenType: z.literal('Bearer'),
});

export const PublicUserSchema = z.object({
  id: ObjectIdSchema,
  phone: z.string(),
  phoneVerified: z.boolean(),
  roles: z.array(z.string()),
  status: z.string(),
  locale: LocaleSchema,
  profile: z.object({
    firstName: z.string(),
    lastName: z.string().optional(),
    avatarUrl: z.string().url().optional(),
    defaultDistrictId: ObjectIdSchema.optional(),
  }),
  shopIds: z.array(ObjectIdSchema),
  twoFactorEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const AuthSessionResponseSchema = TokenPairSchema.extend({ user: PublicUserSchema });

export const UpdateMeRequestSchema = z
  .object({
    firstName: NameSchema.optional(),
    lastName: NameSchema.optional(),
    locale: LocaleSchema.optional(),
    defaultDistrictId: ObjectIdSchema.optional(),
    defaultRegionId: ObjectIdSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const ForgotPasswordRequestSchema = z.object({ phone: PhoneSchema }).strict();

export const ResetPasswordRequestSchema = z
  .object({ phone: PhoneSchema, code: OtpCodeSchema, newPassword: PasswordSchema })
  .strict();

export const ChangePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });

export const PhoneChangeRequestSchema = z
  .object({ newPhone: PhoneSchema, password: z.string().min(1).max(128) })
  .strict();

export const PhoneChangeConfirmSchema = z
  .object({ newPhone: PhoneSchema, codeOld: OtpCodeSchema, codeNew: OtpCodeSchema })
  .strict();

export const DeleteAccountRequestSchema = z
  .object({ password: z.string().min(1).max(128), reason: z.string().max(500).optional() })
  .strict();

export const SessionSchema = z.object({
  id: ObjectIdSchema,
  deviceId: z.string(),
  platform: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  isCurrent: z.boolean(),
});

export const RegisterDeviceRequestSchema = z
  .object({
    deviceId: DeviceIdSchema,
    platform: z.nativeEnum(Platform),
    pushToken: z.string().max(512).optional(),
    appVersion: z.string().max(32).optional(),
    osVersion: z.string().max(32).optional(),
    locale: LocaleSchema.optional(),
  })
  .strict();

export const UpdateDeviceRequestSchema = z
  .object({
    pushToken: z.string().max(512).optional(),
    pushEnabled: z.boolean().optional(),
    locale: LocaleSchema.optional(),
  })
  .strict();

export const TwoFactorConfirmRequestSchema = z.object({ totpCode: OtpCodeSchema }).strict();
export const TwoFactorDisableRequestSchema = z
  .object({ password: z.string().min(1).max(128), totpCode: OtpCodeSchema })
  .strict();
