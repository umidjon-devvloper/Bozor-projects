import { createHash } from 'node:crypto';
import { ClickAction, ClickError } from '../payments.constants.js';

/**
 * Click's callback protocol, as arithmetic.
 *
 * Pure and separate from the HTTP layer because the signature check *is* the authentication:
 * there is no bearer token and no mutual TLS, so anybody who can reach the callback URL can
 * post to it, and the only thing distinguishing Click from an attacker is that Click knows the
 * secret key. That makes this function the security boundary of the whole integration, and it
 * needs to be readable and exhaustively testable without a server.
 *
 * The field order below is transcribed from click-llc's own reference implementation. It is
 * not guessable and not rearrangeable: any other order produces a digest that never matches.
 */

export interface ClickCallback {
  click_trans_id: string;
  service_id: string;
  merchant_trans_id: string;
  merchant_prepare_id?: string | undefined;
  amount: string;
  action: number;
  sign_time: string;
  sign_string: string;
}

/**
 * md5(click_trans_id + service_id + secret + merchant_trans_id + [merchant_prepare_id] + amount
 * + action + sign_time)
 *
 * MD5 is not our choice — it is the protocol's — so this is not a place to be clever. The
 * comparison below is constant-time regardless, because a fast negative answer leaks how much
 * of a forged digest was right.
 */
export function clickSignature(input: ClickCallback, secretKey: string): string {
  const prepareId = input.action === ClickAction.COMPLETE ? (input.merchant_prepare_id ?? '') : '';
  return createHash('md5')
    .update(
      input.click_trans_id +
        input.service_id +
        secretKey +
        input.merchant_trans_id +
        prepareId +
        input.amount +
        String(input.action) +
        input.sign_time,
      'utf8',
    )
    .digest('hex');
}

/** Length-safe, timing-safe comparison of two hex digests. */
export function signatureMatches(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Click sends amounts in som with decimals — `1000.0` — while everything in this system is
 * Int64 tiyin (ADR-0004). This is the conversion, and it refuses rather than rounds.
 *
 * A tenth of a tiyin cannot exist, so a request carrying one is not a payment we can represent
 * and is either a protocol change or a forgery. Rounding it would mean crediting a wallet with
 * a number the payment provider does not agree with, and the discrepancy would surface later
 * as an unreconcilable ledger.
 */
export function clickAmountToMinor(amount: string): bigint | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null;
  const [whole, fraction = ''] = amount.trim().split('.');
  const padded = fraction.padEnd(2, '0');
  return BigInt(whole ?? '0') * 100n + BigInt(padded);
}

export interface ClickVerdict {
  error: number;
  error_note: string;
}

export const CLICK_OK: ClickVerdict = { error: ClickError.SUCCESS, error_note: 'Success' };

export const CLICK_VERDICTS: Readonly<Record<number, ClickVerdict>> = {
  [ClickError.SIGN_CHECK_FAILED]: {
    error: ClickError.SIGN_CHECK_FAILED,
    error_note: 'SIGN CHECK FAILED!',
  },
  [ClickError.INCORRECT_AMOUNT]: {
    error: ClickError.INCORRECT_AMOUNT,
    error_note: 'Incorrect parameter amount',
  },
  [ClickError.ACTION_NOT_FOUND]: {
    error: ClickError.ACTION_NOT_FOUND,
    error_note: 'Action not found',
  },
  [ClickError.ALREADY_PAID]: { error: ClickError.ALREADY_PAID, error_note: 'Already paid' },
  [ClickError.USER_NOT_FOUND]: {
    error: ClickError.USER_NOT_FOUND,
    error_note: 'User does not exist',
  },
  [ClickError.TRANSACTION_NOT_FOUND]: {
    error: ClickError.TRANSACTION_NOT_FOUND,
    error_note: 'Transaction does not exist',
  },
  [ClickError.REQUEST_FROM_CLICK_FAILED]: {
    error: ClickError.REQUEST_FROM_CLICK_FAILED,
    error_note: 'Error in request from click',
  },
  [ClickError.TRANSACTION_CANCELLED]: {
    error: ClickError.TRANSACTION_CANCELLED,
    error_note: 'Transaction cancelled',
  },
};
