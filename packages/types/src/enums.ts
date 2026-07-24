/** Shared domain enums. Single source of truth for every client (ADR-0015). */

export const UserRole = {
  BUYER: 'BUYER',
  SELLER_OWNER: 'SELLER_OWNER',
  SELLER_STAFF: 'SELLER_STAFF',
  COURIER: 'COURIER',
  MODERATOR: 'MODERATOR',
  SUPPORT: 'SUPPORT',
  FINANCE: 'FINANCE',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const USER_ROLES = Object.values(UserRole);

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  PENDING_DELETION: 'PENDING_DELETION',
  DELETED: 'DELETED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const Locale = {
  UZ_LATN: 'uz-Latn',
  UZ_CYRL: 'uz-Cyrl',
  RU: 'ru',
  EN: 'en',
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];
export const LOCALES = Object.values(Locale);
export const DEFAULT_LOCALE: Locale = Locale.UZ_LATN;

export const OtpPurpose = {
  REGISTER: 'REGISTER',
  LOGIN: 'LOGIN',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PHONE_CHANGE: 'PHONE_CHANGE',
  PAYOUT: 'PAYOUT',
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

export const Platform = { IOS: 'IOS', ANDROID: 'ANDROID', WEB: 'WEB' } as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const TokenRevokeReason = {
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  REUSE_DETECTED: 'REUSE_DETECTED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PHONE_CHANGED: 'PHONE_CHANGED',
  ADMIN: 'ADMIN',
  ROTATED: 'ROTATED',
} as const;
export type TokenRevokeReason = (typeof TokenRevokeReason)[keyof typeof TokenRevokeReason];

export const ConsentType = {
  TERMS: 'TERMS',
  PRIVACY: 'PRIVACY',
  MARKETING: 'MARKETING',
  LOCATION: 'LOCATION',
  ANALYTICS: 'ANALYTICS',
} as const;
export type ConsentType = (typeof ConsentType)[keyof typeof ConsentType];

export const ActorType = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
  PROVIDER: 'PROVIDER',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

export const AuditSeverity = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' } as const;
export type AuditSeverity = (typeof AuditSeverity)[keyof typeof AuditSeverity];

export const Currency = { UZS: 'UZS' } as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

/** Geo module enums (Phase 2). */

export const MarketStatus = {
  ACTIVE: 'ACTIVE',
  TEMPORARILY_CLOSED: 'TEMPORARILY_CLOSED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type MarketStatus = (typeof MarketStatus)[keyof typeof MarketStatus];

export const ShopStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type ShopStatus = (typeof ShopStatus)[keyof typeof ShopStatus];

export const ModerationStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type ModerationStatus = (typeof ModerationStatus)[keyof typeof ModerationStatus];

export const ShopMemberRole = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  STAFF: 'STAFF',
} as const;
export type ShopMemberRole = (typeof ShopMemberRole)[keyof typeof ShopMemberRole];

/** 0 = Sunday, matching JavaScript's Date.getDay() so no conversion table is needed. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WorkingHoursEntry {
  weekday: Weekday;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}
