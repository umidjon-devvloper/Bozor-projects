import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  PaymeState,
  createClickController,
  createPaymeController,
  type PaymentService,
} from '../../src/modules/payments/index.js';

/**
 * The two provider callbacks, tested against a stubbed service.
 *
 * These handlers are the only unauthenticated write path in the system, and the only one where
 * being wrong means money was taken and not credited. Payme's sandbox tests exactly these
 * transitions before a merchant contract is activated, so the behaviours below are the
 * acceptance criteria rather than a wish list.
 *
 * No database is involved: the service is faked, which is what makes this worth writing now
 * rather than waiting for an environment that can run Mongo.
 */

const PAYME_KEY = 'test-payme-key';
const CLICK_SECRET = 'test-click-secret';
const SELLER = '507f1f77bcf86cd799439011';

function authHeader(key = PAYME_KEY): string {
  return `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}`;
}

/** Captures whatever the handler sends, in the shape Express would have delivered. */
function stubResponse() {
  const sent: { status: number; body: unknown } = { status: 0, body: null };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

function paymeRequest(method: string, params: Record<string, unknown>, key = PAYME_KEY): Request {
  return {
    body: { id: 1, method, params },
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authHeader(key) : undefined),
  } as unknown as Request;
}

const transaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx1',
  provider: 'PAYME' as const,
  purpose: 'SELLER_TOPUP' as const,
  providerTransactionId: 'p1',
  ownerId: SELLER,
  amountMinor: 1_000_000n,
  state: PaymeState.CREATED,
  reason: null,
  journalEntryId: null,
  createdAt: new Date('2026-08-03T00:00:00Z'),
  performedAt: null,
  cancelledAt: null,
  ...overrides,
});

function fakePayments(overrides: Partial<PaymentService> = {}): PaymentService {
  return {
    checkTopUp: vi.fn(async () => null),
    find: vi.fn(async () => null),
    create: vi.fn(async () => transaction()),
    perform: vi.fn(async () => transaction({ state: PaymeState.COMPLETED, performedAt: new Date() })),
    cancel: vi.fn(async () => transaction({ state: PaymeState.CANCELLED, cancelledAt: new Date() })),
    history: vi.fn(async () => []),
    ...overrides,
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('Payme — authentication', () => {
  it('rejects a wrong key with -32504 and HTTP 200', async () => {
    // Payme reads the JSON-RPC error, not the status code. A 401 would look like success.
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('CheckPerformTransaction', {}, 'wrong'),
      res,
    );

    expect(sent.status).toBe(200);
    expect((sent.body as { error: { code: number } }).error.code).toBe(-32504);
  });

  it('rejects an unknown method with -32601', async () => {
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('DoSomethingElse', {}),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-32601);
  });
});

describe('Payme — CheckPerformTransaction', () => {
  it('answers allow for a known seller and a valid amount', async () => {
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('CheckPerformTransaction', {
        account: { seller_id: SELLER },
        amount: 1_000_000,
      }),
      res,
    );

    expect((sent.body as { result: { allow: boolean } }).result.allow).toBe(true);
  });

  it('returns -31050 for an unknown seller, not -31001', async () => {
    // The account band and the amount error are distinct: Payme shows the customer a different
    // message for each, and the wrong one sends them to check a figure that was never at fault.
    const payments = fakePayments({ checkTopUp: vi.fn(async () => 'ACCOUNT_NOT_FOUND') as never });
    const { res, sent } = stubResponse();
    await createPaymeController(payments, logger).handle(
      paymeRequest('CheckPerformTransaction', { account: { seller_id: SELLER }, amount: 1_000_000 }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31050);
  });

  it('returns -31001 for an amount below the minimum', async () => {
    const payments = fakePayments({ checkTopUp: vi.fn(async () => 'AMOUNT_TOO_SMALL') as never });
    const { res, sent } = stubResponse();
    await createPaymeController(payments, logger).handle(
      paymeRequest('CheckPerformTransaction', { account: { seller_id: SELLER }, amount: 100 }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31001);
  });

  it('rejects a fractional amount, which cannot be tiyin', async () => {
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('CheckPerformTransaction', { account: { seller_id: SELLER }, amount: 100.5 }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31001);
  });

  it('rejects a missing account with -31050', async () => {
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('CheckPerformTransaction', { amount: 1_000_000 }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31050);
  });
});

describe('Payme — idempotency, which the protocol requires', () => {
  it('creates once and answers with the stored transaction on the repeat', async () => {
    // Payme documents that every call is sent twice on purpose and the second must match.
    const create = vi.fn(async () => transaction());
    const payments = fakePayments({ find: vi.fn(async () => null), create: create });
    const controller = createPaymeController(payments, logger);

    const first = stubResponse();
    await controller.handle(
      paymeRequest('CreateTransaction', {
        id: 'p1',
        account: { seller_id: SELLER },
        amount: 1_000_000,
      }),
      first.res,
    );

    const existing = fakePayments({ find: vi.fn(async () => transaction()) });
    const second = stubResponse();
    await createPaymeController(existing, logger).handle(
      paymeRequest('CreateTransaction', {
        id: 'p1',
        account: { seller_id: SELLER },
        amount: 1_000_000,
      }),
      second.res,
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect((second.sent.body as { result: { transaction: string; state: number } }).result).toMatchObject({
      transaction: 'tx1',
      state: PaymeState.CREATED,
    });
  });

  it('does not perform twice — the second call returns the first answer', async () => {
    const performedAt = new Date('2026-08-03T01:00:00Z');
    const perform = vi.fn();
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ state: PaymeState.COMPLETED, performedAt })),
      perform: perform as never,
    });
    const { res, sent } = stubResponse();

    await createPaymeController(payments, logger).handle(
      paymeRequest('PerformTransaction', { id: 'p1' }),
      res,
    );

    // The wallet must not be credited a second time.
    expect(perform).not.toHaveBeenCalled();
    expect((sent.body as { result: { perform_time: number } }).result.perform_time).toBe(
      performedAt.getTime(),
    );
  });

  it('refuses to perform a cancelled transaction', async () => {
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ state: PaymeState.CANCELLED })),
    });
    const { res, sent } = stubResponse();

    await createPaymeController(payments, logger).handle(
      paymeRequest('PerformTransaction', { id: 'p1' }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31008);
  });

  it('reports -31003 for a transaction it has never seen', async () => {
    const { res, sent } = stubResponse();
    await createPaymeController(fakePayments(), logger).handle(
      paymeRequest('PerformTransaction', { id: 'unknown' }),
      res,
    );

    expect((sent.body as { error: { code: number } }).error.code).toBe(-31003);
  });

  it('is idempotent on cancel as well', async () => {
    const cancel = vi.fn();
    const cancelledAt = new Date('2026-08-03T02:00:00Z');
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ state: PaymeState.CANCELLED, cancelledAt })),
      cancel: cancel as never,
    });
    const { res, sent } = stubResponse();

    await createPaymeController(payments, logger).handle(
      paymeRequest('CancelTransaction', { id: 'p1', reason: 5 }),
      res,
    );

    expect(cancel).not.toHaveBeenCalled();
    expect((sent.body as { result: { state: number } }).result.state).toBe(PaymeState.CANCELLED);
  });
});

describe('Payme — CheckTransaction', () => {
  it('reports every timestamp, with zero for what has not happened', async () => {
    const payments = fakePayments({ find: vi.fn(async () => transaction()) });
    const { res, sent } = stubResponse();

    await createPaymeController(payments, logger).handle(
      paymeRequest('CheckTransaction', { id: 'p1' }),
      res,
    );

    const result = (sent.body as { result: Record<string, unknown> }).result;
    expect(result.create_time).toBe(new Date('2026-08-03T00:00:00Z').getTime());
    // Payme expects 0, not null, for a time that has not arrived.
    expect(result.perform_time).toBe(0);
    expect(result.cancel_time).toBe(0);
  });
});

/* -------------------------------------------------------------------- Click */

function clickBody(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    click_trans_id: '1111',
    service_id: '12345',
    merchant_trans_id: SELLER,
    amount: '10000.00',
    action: 0,
    sign_time: '2026-08-03 10:00:00',
    ...overrides,
  };
  const prepare = base.merchant_prepare_id;
  const prepareId = base.action === 1 && typeof prepare === 'string' ? prepare : '';
  const sign = createHash('md5')
    .update(
      String(base.click_trans_id) +
        String(base.service_id) +
        CLICK_SECRET +
        String(base.merchant_trans_id) +
        prepareId +
        String(base.amount) +
        String(base.action) +
        String(base.sign_time),
    )
    .digest('hex');
  return { ...base, sign_string: sign };
}

const clickRequest = (body: Record<string, unknown>) => ({ body }) as unknown as Request;

describe('Click — the signature is the authentication', () => {
  it('rejects a forged signature with -1 and touches nothing', async () => {
    const payments = fakePayments();
    const { res, sent } = stubResponse();

    await createClickController(payments, logger).prepare(
      clickRequest({ ...clickBody(), sign_string: 'f'.repeat(32) }),
      res,
    );

    expect((sent.body as { error: number }).error).toBe(-1);
    expect(payments.find).not.toHaveBeenCalled();
  });

  it('rejects a body missing signed fields with -8', async () => {
    const { res, sent } = stubResponse();
    await createClickController(fakePayments(), logger).prepare(
      clickRequest({ click_trans_id: '1111' }),
      res,
    );

    expect((sent.body as { error: number }).error).toBe(-8);
  });

  it('accepts a correct signature and returns a prepare id', async () => {
    const { res, sent } = stubResponse();
    await createClickController(fakePayments(), logger).prepare(clickRequest(clickBody()), res);

    expect((sent.body as { error: number }).error).toBe(0);
    expect((sent.body as { merchant_prepare_id: string }).merchant_prepare_id).toBe('tx1');
  });

  it('rejects an amount with impossible precision rather than rounding it', async () => {
    const { res, sent } = stubResponse();
    await createClickController(fakePayments(), logger).prepare(
      clickRequest(clickBody({ amount: '10000.555' })),
      res,
    );

    expect((sent.body as { error: number }).error).toBe(-2);
  });

  it('answers a repeated prepare with the same id instead of creating again', async () => {
    const create = vi.fn();
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ provider: 'CLICK' })),
      create: create as never,
    });
    const { res, sent } = stubResponse();

    await createClickController(payments, logger).prepare(clickRequest(clickBody()), res);

    expect(create).not.toHaveBeenCalled();
    expect((sent.body as { merchant_prepare_id: string }).merchant_prepare_id).toBe('tx1');
  });
});

describe('Click — complete', () => {
  it('abandons the transaction when Click reports its own failure', async () => {
    // A negative `error` from Click means the card was never debited. Completing anyway would
    // credit a wallet against money that does not exist.
    const cancel = vi.fn(async () => transaction({ state: PaymeState.CANCELLED }));
    const perform = vi.fn();
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ provider: 'CLICK' })),
      cancel: cancel,
      perform: perform as never,
    });
    const { res, sent } = stubResponse();

    await createClickController(payments, logger).complete(
      clickRequest({ ...clickBody({ action: 1, merchant_prepare_id: 'tx1' }), error: -5 }),
      res,
    );

    expect(perform).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((sent.body as { error: number }).error).toBe(-9);
  });

  it('reports -6 when completing a transaction that was never prepared', async () => {
    const { res, sent } = stubResponse();
    await createClickController(fakePayments(), logger).complete(
      clickRequest(clickBody({ action: 1, merchant_prepare_id: 'tx1' })),
      res,
    );

    expect((sent.body as { error: number }).error).toBe(-6);
  });

  it('does not credit twice — an already completed transaction answers with its id', async () => {
    const perform = vi.fn();
    const payments = fakePayments({
      find: vi.fn(async () => transaction({ provider: 'CLICK', state: PaymeState.COMPLETED })),
      perform: perform as never,
    });
    const { res, sent } = stubResponse();

    await createClickController(payments, logger).complete(
      clickRequest(clickBody({ action: 1, merchant_prepare_id: 'tx1' })),
      res,
    );

    expect(perform).not.toHaveBeenCalled();
    expect((sent.body as { error: number }).error).toBe(0);
    expect((sent.body as { merchant_confirm_id: string }).merchant_confirm_id).toBe('tx1');
  });

  it('rejects a prepare payload sent to complete', async () => {
    const { res, sent } = stubResponse();
    await createClickController(fakePayments(), logger).complete(
      clickRequest(clickBody({ action: 0 })),
      res,
    );

    expect((sent.body as { error: number }).error).toBe(-3);
  });
});
