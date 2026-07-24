import { z } from 'zod';
import { LOCALES } from '@bozorlar/types';

/** E.164, Uzbekistan only. The phone number is the identity in this market (AUTH.md). */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+998\d{9}$/, 'Phone must be in the format +998XXXXXXXXX');

export const ObjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const LocaleSchema = z.enum(LOCALES as [string, ...string[]]);

/** ADR-0028: money crosses the wire as a string of integer minor units. */
export const MoneySchema = z.object({
  amount: z.string().regex(/^-?\d{1,19}$/, 'Amount must be an integer string of minor units'),
  currency: z.literal('UZS'),
});

/** ADR-0025: quantity crosses the wire as a string of integer milli-units. */
export const QuantitySchema = z.object({
  value: z.string().regex(/^\d{1,19}$/, 'Quantity must be an integer string of milli-units'),
  unit: z.string().min(1).max(16),
});

export const LocalizedTextSchema = z.object({
  uz: z.string().trim().min(1).max(2000),
  uzCyrl: z.string().trim().max(2000).optional(),
  ru: z.string().trim().max(2000).optional(),
  en: z.string().trim().max(2000).optional(),
});

export const DeviceIdSchema = z.string().trim().min(8).max(128);

/**
 * Password policy (AUTH.md). Length carries most of the strength; composition rules mainly
 * produce predictable substitutions. The breach-list check happens in the service layer,
 * because it needs I/O and this package must stay pure.
 */
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');

export const IdempotencyKeySchema = z.string().uuid();
