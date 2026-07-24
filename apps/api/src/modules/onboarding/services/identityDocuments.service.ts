import { AppError, ErrorCode, type FieldError } from '@bozorlar/errors';

/**
 * Validation of Uzbek identity and taxpayer numbers.
 *
 * A deliberate omission is recorded here. Uzbekistan's STIR (9-digit taxpayer identification
 * number) has no published control-digit algorithm — unlike Kazakhstan's IIN, whose checksum
 * is documented. Implementing a guessed checksum would reject valid numbers belonging to real
 * sellers, which is strictly worse than not checking: a wrong number is caught by the
 * moderator comparing it against the uploaded certificate, whereas a wrongly rejected
 * applicant simply leaves. Format and obvious-placeholder checks only, therefore, and
 * verification remains a human step.
 */

/** Uzbek biometric passport: two Cyrillic-or-Latin letters followed by seven digits. */
const PASSPORT_SERIES = /^[A-Z]{2}$/;
const PASSPORT_NUMBER = /^\d{7}$/;
const STIR = /^\d{9}$/;

/** Values that are structurally valid but obviously not real, and are typed by habit. */
const PLACEHOLDER_STIRS = new Set([
  '000000000', '111111111', '222222222', '333333333', '444444444',
  '555555555', '666666666', '777777777', '888888888', '999999999',
  '123456789', '987654321',
]);

export interface IdentityDocumentInput {
  passportSeries: string;
  passportNumber: string;
  stir: string;
}

export interface NormalisedIdentityDocuments {
  passportSeries: string;
  passportNumber: string;
  /** Series and number combined; the unit that identifies a document. */
  passportFull: string;
  stir: string;
}

export function normaliseIdentityDocuments(
  input: IdentityDocumentInput,
): NormalisedIdentityDocuments {
  const errors: FieldError[] = [];

  const series = input.passportSeries.trim().toUpperCase().replace(/\s+/g, '');
  const number = input.passportNumber.trim().replace(/\s+/g, '');
  const stir = input.stir.trim().replace(/\s+/g, '');

  if (!PASSPORT_SERIES.test(series)) {
    errors.push({
      field: 'passportSeries',
      code: 'INVALID_PASSPORT_SERIES',
      params: { expected: 'two letters, for example AA' },
    });
  }
  if (!PASSPORT_NUMBER.test(number)) {
    errors.push({
      field: 'passportNumber',
      code: 'INVALID_PASSPORT_NUMBER',
      params: { expected: 'seven digits' },
    });
  }
  if (!STIR.test(stir)) {
    errors.push({ field: 'stir', code: 'INVALID_STIR', params: { expected: 'nine digits' } });
  } else if (PLACEHOLDER_STIRS.has(stir)) {
    errors.push({ field: 'stir', code: 'PLACEHOLDER_STIR' });
  }

  if (errors.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      detail: 'Identity document details are invalid',
      errors,
    });
  }

  return { passportSeries: series, passportNumber: number, passportFull: `${series}${number}`, stir };
}
