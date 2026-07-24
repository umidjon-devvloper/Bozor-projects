import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, forbidden, notFound, validationFailed } from '@bozorlar/errors';

describe('AppError', () => {
  /**
   * Regression test.
   *
   * Bare class-field declarations alongside constructor assignment produced errors whose
   * `code` and `status` were undefined once transpiled with define semantics. Every API
   * response carries `code`, and clients translate on it, so the failure was silent and
   * total: correct status, empty code, nothing renderable. This asserts the properties
   * actually survive construction.
   */
  it('populates every declared property at runtime', () => {
    const error = new AppError(ErrorCode.MEDIA_VIRUS_DETECTED, {
      detail: 'infected',
      params: { signature: 'Eicar' },
    });

    expect(error.code).toBe('MEDIA_VIRUS_DETECTED');
    expect(error.status).toBe(422);
    expect(error.detail).toBe('infected');
    expect(error.params).toEqual({ signature: 'Eicar' });
    expect(error.isOperational).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
  });

  it('maps every catalog code to a status', () => {
    for (const code of Object.values(ErrorCode)) {
      const error = new AppError(code);
      expect(error.status, `${code} has no status`).toBeGreaterThanOrEqual(200);
      expect(error.code).toBe(code);
    }
  });

  it('allows an explicit status override', () => {
    expect(new AppError(ErrorCode.RESOURCE_CONFLICT, { status: 418 }).status).toBe(418);
  });

  it('preserves the cause chain', () => {
    const cause = new Error('underlying');
    expect(new AppError(ErrorCode.SYSTEM_INTERNAL_ERROR, { cause }).cause).toBe(cause);
  });

  it('identifies its own instances', () => {
    expect(AppError.isAppError(new AppError(ErrorCode.AUTH_REQUIRED))).toBe(true);
    expect(AppError.isAppError(new Error('plain'))).toBe(false);
    expect(AppError.isAppError(null)).toBe(false);
  });

  describe('helpers', () => {
    it('notFound keeps the true reason internal', () => {
      // ADR-0029: the client is told the resource is missing; the log keeps why.
      const error = notFound('Shop', 'PERM_SCOPE_DENIED user=1 shop=2');
      expect(error.status).toBe(404);
      expect(error.code).toBe('RESOURCE_NOT_FOUND');
      expect(error.internalReason).toContain('PERM_SCOPE_DENIED');
      expect(error.detail).not.toContain('PERM_SCOPE_DENIED');
    });

    it('forbidden is 403 and validationFailed carries every field', () => {
      expect(forbidden().status).toBe(403);
      const invalid = validationFailed([
        { field: 'phone', code: 'INVALID' },
        { field: 'password', code: 'TOO_SHORT' },
      ]);
      expect(invalid.status).toBe(422);
      expect(invalid.errors).toHaveLength(2);
    });
  });
});
