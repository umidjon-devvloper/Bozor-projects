import type { PublicUser } from '@bozorlar/contracts';
import type { ProfileRecord, UserRecord } from '../repositories/user.repository.js';

/**
 * Central response serializer. Sensitive fields are removed here rather than by per-endpoint
 * projections: one serializer means a new sensitive field is protected everywhere at once,
 * whereas hand-rolled projections are where PII leaks (API.md 8.3).
 */
export function toPublicUser(
  user: UserRecord,
  profile: ProfileRecord | null,
  viewer: { isSelf: boolean },
): PublicUser {
  return {
    id: user.id,
    phone: viewer.isSelf ? user.phone : maskPhone(user.phone),
    phoneVerified: user.phoneVerifiedAt !== null,
    roles: user.roles,
    status: user.status,
    locale: user.locale,
    profile: {
      firstName: profile?.firstName ?? '',
      ...(profile?.lastName ? { lastName: profile.lastName } : {}),
      ...(profile?.defaultDistrictId ? { defaultDistrictId: profile.defaultDistrictId } : {}),
    },
    shopIds: user.shopIds,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

export function maskPhone(phone: string): string {
  return phone.length < 8 ? '***' : `${phone.slice(0, 6)}***${phone.slice(-4)}`;
}
