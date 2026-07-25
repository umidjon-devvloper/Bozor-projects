import type { Request, Response } from 'express';
import { text } from '../../../shared/scalar.js';
import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';
import {
  ClickAction,
  ClickError,
  PAYME_TIMEOUT_MS,
  PaymentProvider,
  PaymeCancelReason,
  PaymeError,
  PaymeState,
} from '../payments.constants.js';
import {
  PaymeRpcError,
  cancelResponseFor,
  checkResponseFor,
  createResponseFor,
  hasTimedOut,
  ms,
  performResponseFor,
  verifyPaymeAuth,
} from '../services/paymeProtocol.js';
import {
  CLICK_OK,
  CLICK_VERDICTS,
  clickAmountToMinor,
  clickSignature,
  signatureMatches,
  type ClickCallback,
} from '../services/clickProtocol.js';
import type { PaymentService } from '../services/payment.service.js';

/**
 * The two providers' wire protocols, translated into the same four service calls.
 *
 * Both of these endpoints are unauthenticated in the ordinary sense — no session, no bearer
 * token — because the caller is a payment provider's server, not a person. What stands in for
 * authentication is the shared secret: Basic auth for Payme, an MD5 signature for Click. Both
 * are checked before anything else is read.
 *
 * Neither endpoint uses the standard error envelope. Payme expects JSON-RPC errors and Click
 * expects HTTP 200 with a negative `error` field; returning our own shape would make a failure
 * look like a success to them, or a success like a failure.
 */

interface PaymeRpcRequest {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(res: Response, id: unknown, code: number, ru: string, data?: string): void {
  res.status(200).json({
    id: id ?? 0,
    result: null,
    error: {
      code,
      message: { ru, uz: ru, en: ru },
      ...(data ? { data } : {}),
    },
  });
}

function rpcOk(res: Response, id: unknown, result: unknown): void {
  res.status(200).json({ id: id ?? 0, result, error: null });
}

export function createPaymeController(payments: PaymentService, logger: Logger) {
  /**
   * Payme's account field is configured in the cashbox and arrives verbatim. We register it as
   * `seller_id`, so this is the only place that knows the provider's field naming.
   */
  function sellerIdFrom(params: Record<string, unknown>): string | null {
    const account = params.account as Record<string, unknown> | undefined;
    const value = account?.seller_id;
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function amountFrom(params: Record<string, unknown>): bigint | null {
    const amount = params.amount;
    // Payme sends tiyin as a JSON number. Anything fractional is not an amount we can hold.
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null;
    return BigInt(amount);
  }

  return {
    handle: async (req: Request, res: Response): Promise<void> => {
      const body = req.body as PaymeRpcRequest;
      const id = body.id;

      if (!verifyPaymeAuth(req.header('authorization'), { key: env.PAYME_KEY ?? '' })) {
        rpcError(res, id, PaymeError.INSUFFICIENT_PRIVILEGE, 'Недостаточно привилегий');
        return;
      }
      if (!body.method || typeof body.params !== 'object' || body.params === null) {
        rpcError(res, id, PaymeError.INVALID_JSON_RPC, 'Неверный JSON-RPC объект');
        return;
      }

      const params = body.params;
      const now = new Date();

      try {
        switch (body.method) {
          case 'CheckPerformTransaction': {
            const sellerId = sellerIdFrom(params);
            const amountMinor = amountFrom(params);
            if (!sellerId) {
              throw new PaymeRpcError(PaymeError.INVALID_ACCOUNT, 'Неверный код продавца', 'account');
            }
            if (amountMinor === null) {
              throw new PaymeRpcError(PaymeError.INVALID_AMOUNT, 'Неверная сумма', 'amount');
            }
            const failure = await payments.checkTopUp({ sellerId, amountMinor });
            if (failure === 'ACCOUNT_NOT_FOUND') {
              throw new PaymeRpcError(PaymeError.INVALID_ACCOUNT, 'Продавец не найден', 'account');
            }
            if (failure) {
              throw new PaymeRpcError(PaymeError.INVALID_AMOUNT, 'Сумма вне допустимых границ', 'amount');
            }
            rpcOk(res, id, { allow: true });
            return;
          }

          case 'CreateTransaction': {
            const providerTransactionId = text(params.id);
            const existing = await payments.find(PaymentProvider.PAYME, providerTransactionId);
            if (existing) {
              // The repeat that Payme sends by design. Same answer as the first, or an error
              // if the transaction has since moved on.
              rpcOk(res, id, createResponseFor(existing, now));
              return;
            }

            const sellerId = sellerIdFrom(params);
            const amountMinor = amountFrom(params);
            if (!sellerId) {
              throw new PaymeRpcError(PaymeError.INVALID_ACCOUNT, 'Неверный код продавца', 'account');
            }
            if (amountMinor === null) {
              throw new PaymeRpcError(PaymeError.INVALID_AMOUNT, 'Неверная сумма', 'amount');
            }
            const failure = await payments.checkTopUp({ sellerId, amountMinor });
            if (failure === 'ACCOUNT_NOT_FOUND') {
              throw new PaymeRpcError(PaymeError.INVALID_ACCOUNT, 'Продавец не найден', 'account');
            }
            if (failure) {
              throw new PaymeRpcError(PaymeError.INVALID_AMOUNT, 'Сумма вне допустимых границ', 'amount');
            }

            const created = await payments.create({
              provider: PaymentProvider.PAYME,
              providerTransactionId,
              providerReference: text(params.time) || null,
              sellerId,
              amountMinor,
              rawAccount: (params.account as Record<string, unknown>) ?? {},
            });
            rpcOk(res, id, {
              create_time: ms(created.createdAt),
              transaction: created.id,
              state: created.state,
            });
            return;
          }

          case 'PerformTransaction': {
            const found = await payments.find(PaymentProvider.PAYME, text(params.id));
            if (!found) {
              throw new PaymeRpcError(PaymeError.TRANSACTION_NOT_FOUND, 'Транзакция не найдена');
            }
            const stored = performResponseFor(found, now);
            if (stored) {
              rpcOk(res, id, stored);
              return;
            }
            const performed = await payments.perform(found, now);
            if (!performed) {
              throw new PaymeRpcError(PaymeError.COULD_NOT_PERFORM, 'Не удалось провести транзакцию');
            }
            rpcOk(res, id, {
              transaction: performed.id,
              perform_time: ms(performed.performedAt),
              state: performed.state,
            });
            return;
          }

          case 'CancelTransaction': {
            const found = await payments.find(PaymentProvider.PAYME, text(params.id));
            if (!found) {
              throw new PaymeRpcError(PaymeError.TRANSACTION_NOT_FOUND, 'Транзакция не найдена');
            }
            if (found.state < 0) {
              rpcOk(res, id, cancelResponseFor(found));
              return;
            }
            const reason = typeof params.reason === 'number' ? params.reason : PaymeCancelReason.UNKNOWN;
            const cancelled = await payments.cancel(found, reason, now);
            if (!cancelled) {
              throw new PaymeRpcError(PaymeError.COULD_NOT_CANCEL, 'Не удалось отменить транзакцию');
            }
            rpcOk(res, id, cancelResponseFor(cancelled));
            return;
          }

          case 'CheckTransaction': {
            const found = await payments.find(PaymentProvider.PAYME, text(params.id));
            if (!found) {
              throw new PaymeRpcError(PaymeError.TRANSACTION_NOT_FOUND, 'Транзакция не найдена');
            }
            rpcOk(res, id, checkResponseFor(found));
            return;
          }

          default:
            rpcError(res, id, PaymeError.METHOD_NOT_FOUND, `Метод ${body.method} не найден`);
            return;
        }
      } catch (error) {
        if (error instanceof PaymeRpcError) {
          rpcError(res, id, error.code, error.ru, error.data);
          return;
        }
        logger.error({ err: error, method: body.method }, 'payme merchant api failed');
        rpcError(res, id, PaymeError.INTERNAL_SYSTEM, 'Внутренняя ошибка');
      }
    },

    timeoutMs: PAYME_TIMEOUT_MS,
  };
}

export function createClickController(payments: PaymentService, logger: Logger) {
  function readCallback(req: Request): ClickCallback | null {
    const body = req.body as Record<string, unknown>;
    const required = [
      'click_trans_id',
      'service_id',
      'merchant_trans_id',
      'amount',
      'action',
      'sign_time',
      'sign_string',
    ];
    if (required.some((field) => body[field] === undefined || body[field] === null)) return null;
    return {
      click_trans_id: text(body.click_trans_id),
      service_id: text(body.service_id),
      merchant_trans_id: text(body.merchant_trans_id),
      merchant_prepare_id:
        body.merchant_prepare_id === undefined ? undefined : text(body.merchant_prepare_id),
      amount: text(body.amount),
      action: Number(body.action),
      sign_time: text(body.sign_time),
      sign_string: text(body.sign_string),
    };
  }

  /** Click reads only these fields; anything else in the body is ignored by them and by us. */
  function reply(res: Response, callback: ClickCallback, verdict: { error: number; error_note: string }, extra: Record<string, unknown> = {}): void {
    res.status(200).json({
      click_trans_id: callback.click_trans_id,
      merchant_trans_id: callback.merchant_trans_id,
      ...extra,
      ...verdict,
    });
  }

  function authenticate(req: Request, res: Response): ClickCallback | null {
    const callback = readCallback(req);
    if (!callback) {
      res.status(200).json(CLICK_VERDICTS[ClickError.REQUEST_FROM_CLICK_FAILED]);
      return null;
    }
    const expected = clickSignature(callback, env.CLICK_SECRET_KEY ?? '');
    if (!signatureMatches(expected, callback.sign_string)) {
      logger.warn({ clickTransId: callback.click_trans_id }, 'click signature rejected');
      reply(res, callback, CLICK_VERDICTS[ClickError.SIGN_CHECK_FAILED] ?? CLICK_OK);
      return null;
    }
    return callback;
  }

  return {
    /** Action 0. Reserve nothing, promise nothing, but answer honestly. */
    prepare: async (req: Request, res: Response): Promise<void> => {
      const callback = authenticate(req, res);
      if (!callback) return;
      if (callback.action !== ClickAction.PREPARE) {
        reply(res, callback, CLICK_VERDICTS[ClickError.ACTION_NOT_FOUND] ?? CLICK_OK);
        return;
      }

      const amountMinor = clickAmountToMinor(callback.amount);
      if (amountMinor === null) {
        reply(res, callback, CLICK_VERDICTS[ClickError.INCORRECT_AMOUNT] ?? CLICK_OK);
        return;
      }

      const existing = await payments.find(PaymentProvider.CLICK, callback.click_trans_id);
      if (existing) {
        // Click retries too. A prepared transaction answers with the same prepare id.
        reply(res, callback, CLICK_OK, { merchant_prepare_id: existing.id });
        return;
      }

      const failure = await payments.checkTopUp({
        sellerId: callback.merchant_trans_id,
        amountMinor,
      });
      if (failure === 'ACCOUNT_NOT_FOUND') {
        reply(res, callback, CLICK_VERDICTS[ClickError.USER_NOT_FOUND] ?? CLICK_OK);
        return;
      }
      if (failure) {
        reply(res, callback, CLICK_VERDICTS[ClickError.INCORRECT_AMOUNT] ?? CLICK_OK);
        return;
      }

      const created = await payments.create({
        provider: PaymentProvider.CLICK,
        providerTransactionId: callback.click_trans_id,
        providerReference: text((req.body as Record<string, unknown>).click_paydoc_id),
        sellerId: callback.merchant_trans_id,
        amountMinor,
        rawAccount: { merchant_trans_id: callback.merchant_trans_id },
      });
      reply(res, callback, CLICK_OK, { merchant_prepare_id: created.id });
    },

    /**
     * Action 1. The money has either been taken or it has not, and Click says which through
     * its own `error` field — a negative value there means the card was not debited and the
     * transaction must be abandoned, not completed.
     */
    complete: async (req: Request, res: Response): Promise<void> => {
      const callback = authenticate(req, res);
      if (!callback) return;
      if (callback.action !== ClickAction.COMPLETE) {
        reply(res, callback, CLICK_VERDICTS[ClickError.ACTION_NOT_FOUND] ?? CLICK_OK);
        return;
      }

      const found = await payments.find(PaymentProvider.CLICK, callback.click_trans_id);
      if (!found) {
        reply(res, callback, CLICK_VERDICTS[ClickError.TRANSACTION_NOT_FOUND] ?? CLICK_OK);
        return;
      }
      if (found.state < 0) {
        reply(res, callback, CLICK_VERDICTS[ClickError.TRANSACTION_CANCELLED] ?? CLICK_OK);
        return;
      }
      if (found.state === PaymeState.COMPLETED) {
        reply(res, callback, CLICK_OK, { merchant_confirm_id: found.id });
        return;
      }

      const clickError = Number((req.body as Record<string, unknown>).error ?? 0);
      if (clickError < 0) {
        await payments.cancel(found, PaymeCancelReason.EXECUTION_FAILED, new Date());
        reply(res, callback, CLICK_VERDICTS[ClickError.TRANSACTION_CANCELLED] ?? CLICK_OK);
        return;
      }

      if (hasTimedOut(found, new Date())) {
        await payments.cancel(found, PaymeCancelReason.CANCELLED_BY_TIMEOUT, new Date());
        reply(res, callback, CLICK_VERDICTS[ClickError.TRANSACTION_CANCELLED] ?? CLICK_OK);
        return;
      }

      const performed = await payments.perform(found, new Date());
      if (!performed) {
        reply(res, callback, CLICK_VERDICTS[ClickError.FAILED_TO_UPDATE] ?? CLICK_OK);
        return;
      }
      reply(res, callback, CLICK_OK, { merchant_confirm_id: performed.id });
    },
  };
}

export type PaymeController = ReturnType<typeof createPaymeController>;
export type ClickController = ReturnType<typeof createClickController>;
