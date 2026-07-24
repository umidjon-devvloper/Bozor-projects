import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TRANSITIONS,
  ApplicationStatus,
  MAX_RESUBMISSIONS,
  REQUIRED_DOCUMENTS,
  TERMINAL_STATUSES,
} from '../../src/modules/onboarding/onboarding.constants.js';
import { ApplicationStatusSchema, DocumentTypeSchema, RejectionReasonCodeSchema } from '@bozorlar/contracts';
import { DocumentType, RejectionReasonCode } from '../../src/modules/onboarding/onboarding.constants.js';

describe('application state machine', () => {
  it('declares transitions for every status', () => {
    for (const status of Object.values(ApplicationStatus)) {
      expect(APPLICATION_TRANSITIONS[status], status).toBeDefined();
    }
  });

  it('makes approval and withdrawal terminal', () => {
    expect(APPLICATION_TRANSITIONS.APPROVED).toHaveLength(0);
    expect(APPLICATION_TRANSITIONS.WITHDRAWN).toHaveLength(0);
    for (const status of TERMINAL_STATUSES) {
      expect(APPLICATION_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('only allows a decision from UNDER_REVIEW', () => {
    // A moderator must claim before deciding, which is what makes concurrent review safe.
    expect(APPLICATION_TRANSITIONS.SUBMITTED).not.toContain(ApplicationStatus.APPROVED);
    expect(APPLICATION_TRANSITIONS.SUBMITTED).not.toContain(ApplicationStatus.REJECTED);
    expect(APPLICATION_TRANSITIONS.UNDER_REVIEW).toEqual(
      expect.arrayContaining([ApplicationStatus.APPROVED, ApplicationStatus.REJECTED]),
    );
  });

  it('lets a rejected application be resubmitted but never withdrawn from review', () => {
    expect(APPLICATION_TRANSITIONS.REJECTED).toEqual([ApplicationStatus.SUBMITTED]);
    expect(APPLICATION_TRANSITIONS.UNDER_REVIEW).not.toContain(ApplicationStatus.WITHDRAWN);
  });

  it('cannot reach APPROVED without passing through review', () => {
    const reachesApproved = Object.entries(APPLICATION_TRANSITIONS)
      .filter(([, next]) => next.includes(ApplicationStatus.APPROVED))
      .map(([from]) => from);
    expect(reachesApproved).toEqual([ApplicationStatus.UNDER_REVIEW]);
  });

  it('has no transition back into DRAFT', () => {
    for (const next of Object.values(APPLICATION_TRANSITIONS)) {
      expect(next).not.toContain(ApplicationStatus.DRAFT);
    }
  });
});

describe('onboarding constants', () => {
  it('requires the documents a moderator cannot verify identity without', () => {
    expect(REQUIRED_DOCUMENTS).toContain(DocumentType.PASSPORT);
    expect(REQUIRED_DOCUMENTS).toContain(DocumentType.MARKET_CONTRACT);
  });

  it('caps resubmissions so the queue cannot be looped for free', () => {
    expect(MAX_RESUBMISSIONS).toBeGreaterThan(0);
    expect(MAX_RESUBMISSIONS).toBeLessThanOrEqual(5);
  });

  it('keeps the wire enums and the server enums in step', () => {
    // packages/contracts cannot import from an app (ADR-0011), so these are duplicated.
    // Drift becomes a failing build rather than a runtime surprise.
    expect([...ApplicationStatusSchema.options].sort()).toEqual(Object.values(ApplicationStatus).sort());
    expect([...DocumentTypeSchema.options].sort()).toEqual(Object.values(DocumentType).sort());
    expect([...RejectionReasonCodeSchema.options].sort()).toEqual(
      Object.values(RejectionReasonCode).sort(),
    );
  });
});
