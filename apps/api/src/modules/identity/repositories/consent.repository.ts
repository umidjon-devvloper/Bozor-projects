import { Types } from 'mongoose';
import type { ConsentType } from '@bozorlar/types';
import { UserConsentModel } from '../models/userConsent.model.js';
import type { ClientSession } from 'mongoose';

export const consentRepository = {
  async record(
    entries: Array<{
      userId: string;
      type: ConsentType;
      documentVersion: string;
      granted: boolean;
      ip?: string | null;
      userAgent?: string | null;
    }>,
    session?: ClientSession,
  ): Promise<void> {
    if (entries.length === 0) return;
    await UserConsentModel.create(
      entries.map((entry) => ({
        userId: new Types.ObjectId(entry.userId),
        type: entry.type,
        documentVersion: entry.documentVersion,
        granted: entry.granted,
        grantedAt: new Date(),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      })),
      session ? { session } : {},
    );
  },
};
