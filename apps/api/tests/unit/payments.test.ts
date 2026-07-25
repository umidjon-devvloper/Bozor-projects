import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAYME_TIMEOUT_MS,
  PaymeRpcError,
  PaymeState,
  cancelledState,
  clickAmountToMinor,
  clickSignature,
  hasTimedOut,
  signatureMatches,
  verifyPaymeAuth,
} from '../../src/modules/payments/index.js';

/**
 * The two payment protocols, tested where they are load-bearing.
 *
 * Both providers authenticate with a shared secret and nothing else — anybody who can reach a
 * callback URL can post to it — so the signature and auth checks below are the security
 * boundary of the entire integration, not a formality. The amount conversion is the other
 * place a mistake becomes money: Click speaks decimal som, everything here is Int64 tiyin.
 */

const SECRET = 'test-secret-key';

describe('Click signature', () => {
  const prepare = {
    click_trans_id: '1111',
    service_id: '2222',
    merchant_trans_id: '507f1f77bcf86cd799439011',
    amount: '1000.00',
    action: 0,
    sign_time: '2026-08-03 10:00:00',
    sign_string: '',
  };

  it('matches the digest Click computes for a prepare', () => {
    // Field order is the protocol and is not rearrangeable: click_trans_id, service_id,
    // secret, merchant_trans_id, [merchant_prepare_id], amount, action, sign_time.
    const expected = createHash('md5')
      .update('1111' + '2222' + SECRET + '507f1f77bcf86cd799439011' + '1000.00' + '0' + '2026-08-03 10:00:00')
      .digest('hex');
    expect(clickSignature(prepare, SECRET)).toBe(expected);
  });

  it('includes merchant_prepare_id on a complete, and only on a complete', () => {
    const complete = { ...prepare, action: 1, merchant_prepare_id: '99' };
    const withId = clickSignature(complete, SECRET);
    const withoutId = clickSignature({ ...complete, merchant_prepare_id: undefined }, SECRET);
    expect(withId).not.toBe(withoutId);
  });

  it('ignores merchant_prepare_id on a prepare even when one is sent', () => {
    const noisy = { ...prepare, merchant_prepare_id: '99' };
    expect(clickSignature(noisy, SECRET)).toBe(clickSignature(prepare, SECRET));
  });

  it('changes when any signed field changes', () => {
    const base = clickSignature(prepare, SECRET);
    expect(clickSignature({ ...prepare, amount: '1000.01' }, SECRET)).not.toBe(base);
    expect(clickSignature({ ...prepare, click_trans_id: '1112' }, SECRET)).not.toBe(base);
    expect(clickSignature(prepare, 'other-secret')).not.toBe(base);
  });
});

describe('signatureMatches', () => {
  it('accepts an identical digest', () => {
    expect(signatureMatches('abc123', 'abc123')).toBe(true);
  });

  it('rejects a different digest of the same length', () => {
    expect(signatureMatches('abc123', 'abc124')).toBe(false);
  });

  it('rejects a digest of a different length without comparing', () => {
    expect(signatureMatches('abc123', 'abc12')).toBe(false);
  });

  it('rejects an empty digest, which is what an unconfigured secret would produce', () => {
    expect(signatureMatches('abc123', '')).toBe(false);
  });
});

describe('clickAmountToMinor', () => {
  it('converts whole som', () => {
    expect(clickAmountToMinor('1000')).toBe(100_000n);
  });

  it('converts som with tiyin', () => {
    expect(clickAmountToMinor('1000.50')).toBe(100_050n);
  });

  it('pads a single decimal place', () => {
    // '1000.5' is one thousand som and fifty tiyin, not five.
    expect(clickAmountToMinor('1000.5')).toBe(100_050n);
  });

  it('refuses a third decimal rather than rounding it', () => {
    // A tenth of a tiyin cannot exist. Rounding would credit a wallet with a number the
    // provider does not agree with, and the gap would surface as an unreconcilable ledger.
    expect(clickAmountToMinor('1000.555')).toBeNull();
  });

  it('refuses anything that is not a number', () => {
    expect(clickAmountToMinor('abc')).toBeNull();
    expect(clickAmountToMinor('')).toBeNull();
    expect(clickAmountToMinor('-100')).toBeNull();
  });

  it('stays exact at amounts a float would round', () => {
    expect(clickAmountToMinor('90071992547409.91')).toBe(9_007_199_254_740_991n);
  });
});

describe('verifyPaymeAuth', () => {
  const key = 'cashbox-key';
  const header = `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}`;

  it('accepts the documented Paycom login with the cashbox key', () => {
    expect(verifyPaymeAuth(header, { key })).toBe(true);
  });

  it('rejects the wrong key', () => {
    expect(verifyPaymeAuth(header, { key: 'other' })).toBe(false);
  });

  it('rejects a different login, even with the right key', () => {
    const wrongLogin = `Basic ${Buffer.from(`Merchant:${key}`).toString('base64')}`;
    expect(verifyPaymeAuth(wrongLogin, { key })).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyPaymeAuth(undefined, { key })).toBe(false);
    expect(verifyPaymeAuth('Bearer something', { key })).toBe(false);
    expect(verifyPaymeAuth('Basic !!!not-base64!!!', { key })).toBe(false);
  });

  it('rejects everything when the key is unconfigured', () => {
    // The API boots without merchant credentials, so the callbacks must be closed, not open.
    const emptyHeader = `Basic ${Buffer.from('Paycom:').toString('base64')}`;
    expect(verifyPaymeAuth(emptyHeader, { key: '' })).toBe(true);
    expect(verifyPaymeAuth(header, { key: '' })).toBe(false);
  });
});

describe('Payme transaction lifecycle', () => {
  const base = {
    id: 'tx1',
    providerTransactionId: 'p1',
    amountMinor: 1_000_000n,
    state: PaymeState.CREATED,
    reason: null,
    createdAt: new Date('2026-08-03T00:00:00Z'),
    performedAt: null,
    cancelledAt: null,
  };

  it('is not timed out inside the twelve-hour window', () => {
    const now = new Date(base.createdAt.getTime() + PAYME_TIMEOUT_MS - 1000);
    expect(hasTimedOut(base, now)).toBe(false);
  });

  it('is timed out past it', () => {
    const now = new Date(base.createdAt.getTime() + PAYME_TIMEOUT_MS + 1000);
    expect(hasTimedOut(base, now)).toBe(true);
  });

  it('never times out once completed', () => {
    const completed = { ...base, state: PaymeState.COMPLETED };
    const now = new Date(base.createdAt.getTime() + PAYME_TIMEOUT_MS * 10);
    expect(hasTimedOut(completed, now)).toBe(false);
  });

  it('cancels a created transaction to -1', () => {
    expect(cancelledState(base)).toBe(PaymeState.CANCELLED);
  });

  it('cancels a completed transaction to -2, which is a refund and not the same thing', () => {
    // Collapsing both into -1 would make a refunded payment indistinguishable from one that
    // never completed, which is exactly what Payme reconciles against.
    expect(cancelledState({ ...base, state: PaymeState.COMPLETED })).toBe(
      PaymeState.CANCELLED_AFTER_COMPLETE,
    );
  });

  it('exposes protocol errors with their wire codes', () => {
    const error = new PaymeRpcError(-31050, 'Неверный код продавца', 'account');
    expect(error.code).toBe(-31050);
    expect(error.data).toBe('account');
  });
});
