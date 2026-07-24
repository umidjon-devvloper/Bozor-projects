import { describe, expect, it } from 'vitest';
import { MediaPurposeSchema } from '@bozorlar/contracts';
import {
  MediaPurpose,
  MediaVisibility,
  PURPOSE_POLICIES,
} from '../../src/modules/media/media.constants.js';

describe('purpose policies', () => {
  it('declares a policy for every purpose', () => {
    for (const purpose of Object.values(MediaPurpose)) {
      expect(PURPOSE_POLICIES[purpose], `missing policy for ${purpose}`).toBeDefined();
    }
  });

  it('keeps the wire enum and the server enum in step', () => {
    // packages/contracts cannot import from an app (ADR-0011), so the enum is duplicated.
    // This assertion is what makes that duplication safe: drift fails the build.
    expect([...MediaPurposeSchema.options].sort()).toEqual(Object.values(MediaPurpose).sort());
  });

  it('keeps identity documents and dispute evidence private', () => {
    expect(PURPOSE_POLICIES.KYC_DOCUMENT.visibility).toBe(MediaVisibility.PRIVATE);
    expect(PURPOSE_POLICIES.DISPUTE_EVIDENCE.visibility).toBe(MediaVisibility.PRIVATE);
  });

  it('never re-encodes evidence', () => {
    // A moderator must see exactly what was submitted, not a recompressed approximation.
    expect(PURPOSE_POLICIES.KYC_DOCUMENT.reencode).toBe(false);
    expect(PURPOSE_POLICIES.KYC_DOCUMENT.variants).toHaveLength(0);
    expect(PURPOSE_POLICIES.DISPUTE_EVIDENCE.reencode).toBe(false);
  });

  it('re-encodes every public image, which is what strips EXIF GPS', () => {
    for (const [purpose, policy] of Object.entries(PURPOSE_POLICIES)) {
      if (policy.visibility !== MediaVisibility.PUBLIC) continue;
      expect(policy.reencode, `${purpose} must be re-encoded`).toBe(true);
    }
  });

  it('only permits PDFs where a document is genuinely expected', () => {
    for (const [purpose, policy] of Object.entries(PURPOSE_POLICIES)) {
      if (policy.allowedMimeTypes.includes('application/pdf')) {
        expect(['KYC_DOCUMENT', 'DISPUTE_EVIDENCE']).toContain(purpose);
      }
    }
  });

  it('bounds every policy with a size cap and a daily quota', () => {
    for (const [purpose, policy] of Object.entries(PURPOSE_POLICIES)) {
      expect(policy.maxSizeBytes, purpose).toBeGreaterThan(0);
      expect(policy.maxSizeBytes, purpose).toBeLessThanOrEqual(20 * 1024 * 1024);
      expect(policy.dailyQuota, purpose).toBeGreaterThan(0);
      expect(policy.allowedMimeTypes.length, purpose).toBeGreaterThan(0);
    }
  });
});
