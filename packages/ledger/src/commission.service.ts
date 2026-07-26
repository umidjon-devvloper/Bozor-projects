import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import { Money } from '@bozorlar/money';
import { Account, EntrySide, evaluateWalletState, WalletState } from '@bozorlar/domain';
import { ledgerRepository } from './ledger.repository.js';
import { walletRepository } from './wallet.repository.js';
import { commissionRuleRepository } from './commissionRule.repository.js';
import { CommissionFailureReason, EntryType, WalletEvents } from './constants.js';

/** Minimal logger shape, so this package does not depend on the logging implementation. */
export interface LedgerLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/**
 * Ports.
 *
 * The ledger is driven by two deployables — the API for administrative movements, the worker
 * for charging on `order.completed` — and neither may import the other (ADR-0011). Publishing
 * and auditing are therefore injected, so the money logic below exists exactly once and each
 * app supplies its own plumbing.
 */
export interface EventPublisher {
  publish(
    event: {
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      actorId?: string | null;
    },
    session: mongoose.ClientSession,
  ): Promise<void>;
}

export interface AuditRecorder {
  record(entry: {
    actorId?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    after?: Record<string, unknown> | null;
    reason?: string | null;
    critical?: boolean;
  }): Promise<void>;
}

/** What the charger needs to know about an order. Supplied by the orders module. */
export interface ChargeableOrder {
  id: string;
  orderNo: string;
  sellerId: string;
  shopId: string;
  marketId: string;
  categoryIds: string[];
  totalMinor: bigint;
  createdAt: Date;
  completedAt: Date;
  commissionStatus: string;
}

export interface OrderCommissionWriter {
  recordCharged(
    orderId: string,
    input: { ruleId: string; percentBp: number; amountMinor: bigint; journalEntryId: string },
    session: mongoose.ClientSession,
  ): Promise<void>;
  recordFailed(orderId: string, reason: string): Promise<void>;
}

export interface ChargeResult {
  charged: boolean;
  amount: Money | null;
  reason?: CommissionFailureReason;
}

/**
 * MongoDB reports a unique-index collision as error code 11000, on both the driver's
 * `MongoServerError` and the wrapper Mongoose throws. Matched on the code rather than the
 * message, which is not stable across versions or locales.
 */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export function createCommissionService(deps: {
  orders: OrderCommissionWriter;
  events: EventPublisher;
  audit: AuditRecorder;
  logger: LedgerLogger;
}) {
  const { orders, events, audit, logger } = deps;

  return {
    /**
     * Charges commission for a completed order.
     *
     * Idempotent by construction: the journal entry's natural key is derived from the order
     * id, so a redelivered `order.completed` finds the entry already there and does nothing.
     * At-least-once delivery is the only guarantee the outbox offers, and double-billing a
     * seller is the single worst thing this module could do.
     */
    async chargeForOrder(order: ChargeableOrder): Promise<ChargeResult> {
      const entryKey = `commission:${order.id}`;

      const existing = await ledgerRepository.findByKey(entryKey);
      if (existing) {
        logger.debug({ orderId: order.id }, 'commission already charged; ignoring redelivery');
        return { charged: true, amount: existing.total };
      }

      const rule = await commissionRuleRepository.resolve({
        // The order's own creation time, not the clock (ADR-0033).
        at: order.createdAt,
        shopId: order.shopId,
        marketId: order.marketId,
        categoryIds: order.categoryIds,
      });

      if (!rule) {
        // Loud, not silent. The order stands; the platform's failure to bill is the
        // platform's problem, and it is visible rather than lost.
        await orders.recordFailed(order.id, CommissionFailureReason.NO_APPLICABLE_RULE);
        await audit.record({
          action: 'commission.no_rule',
          targetType: 'order',
          targetId: order.id,
          after: { orderNo: order.orderNo, sellerId: order.sellerId },
          critical: true,
        });
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            await events.publish(
              {
                type: WalletEvents.COMMISSION_FAILED,
                aggregateType: 'order',
                aggregateId: order.id,
                payload: { orderId: order.id, reason: CommissionFailureReason.NO_APPLICABLE_RULE },
              },
              session,
            );
          });
        } finally {
          await session.endSession();
        }
        logger.error({ orderId: order.id, orderNo: order.orderNo }, 'no commission rule applies');
        return { charged: false, amount: null, reason: CommissionFailureReason.NO_APPLICABLE_RULE };
      }

      const gross = Money.of(order.totalMinor);
      const amount = gross.percentBp(rule.percentBp).clamp(rule.minCharge, rule.maxCharge);

      if (amount.isZero()) {
        // A zero-rate rule is a legitimate promotional arrangement, not a failure. Nothing is
        // posted, because a ledger entry for nothing is noise.
        await orders.recordFailed(order.id, 'ZERO_RATE');
        return { charged: true, amount };
      }

      const wallet = await walletRepository.ensureFor(order.sellerId);

      const session = await mongoose.startSession();
      let result: ChargeResult;
      try {
        result = await session.withTransaction(async () => {
          const entry = await ledgerRepository.post(
            {
              entryKey,
              type: EntryType.COMMISSION_CHARGE,
              occurredAt: order.completedAt,
              lines: [
                // The platform owes the seller less than it did; that reduction is revenue.
                {
                  account: Account.SELLER_WALLET,
                  side: EntrySide.DEBIT,
                  amountMinor: amount.minor,
                  walletId: wallet.id,
                  ownerId: order.sellerId,
                },
                {
                  account: Account.PLATFORM_REVENUE_COMMISSION,
                  side: EntrySide.CREDIT,
                  amountMinor: amount.minor,
                },
              ],
              reference: { type: 'order', id: order.id },
              memo: `Commission ${rule.percentBp / 100}% on ${order.orderNo}`,
            },
            session,
          );

          await orders.recordCharged(
            order.id,
            {
              ruleId: rule.id,
              percentBp: rule.percentBp,
              amountMinor: amount.minor,
              journalEntryId: entry.id,
            },
            session,
          );

          await events.publish(
              {
              type: WalletEvents.COMMISSION_CHARGED,
              aggregateType: 'order',
              aggregateId: order.id,
              payload: {
                orderId: order.id,
                sellerId: order.sellerId,
                walletId: wallet.id,
                amount: amount.toStorage(),
                percentBp: rule.percentBp,
              },
            },
            session,
          );
          return { charged: true, amount };
        });
      } catch (error) {
        /**
         * A duplicate entry key means somebody else charged this order between the check above
         * and this write — two redeliveries of `order.completed` racing each other.
         *
         * The unique index is what actually prevents the double charge, and it does its job.
         * What was missing is the reading: an already-charged order surfaced as an error, the
         * relay counted a failed attempt, and with attempts now capped that could push a
         * correctly-charged order into the set-aside pile looking like a billing failure.
         * It is not a failure. It is the answer arriving from another worker.
         */
        if (isDuplicateKey(error)) {
          const charged = await ledgerRepository.findByKey(entryKey);
          logger.debug({ orderId: order.id }, 'commission charged concurrently; treating as done');
          return charged ? { charged: true, amount: charged.total } : { charged: true, amount };
        }
        throw error;
      } finally {
        await session.endSession();
      }

      await this.evaluateState(wallet.id);
      logger.info(
        { orderId: order.id, sellerId: order.sellerId, amount: amount.toStorage() },
        'commission charged',
      );
      return result;
    },

    /**
     * Re-reads the wallet and applies the state rule, emitting the deactivation event the geo
     * module's `sellerWalletActive` flag follows.
     */
    async evaluateState(walletId: string): Promise<WalletState> {
      const wallet = await walletRepository.findById(walletId);
      if (!wallet) throw notFound('Wallet');

      const now = new Date();
      const evaluation = evaluateWalletState({
        balanceMinor: wallet.balance.minor,
        lowBalanceThresholdMinor: wallet.lowBalanceThreshold.minor,
        deactivateBelowMinor: wallet.deactivateBelow.minor,
        belowFloorSince: wallet.belowFloorSince,
        graceHours: wallet.graceHours,
        now,
      });

      const wasBelowFloor = wallet.belowFloorSince !== null;
      const isBelowFloor = wallet.balance.minor <= wallet.deactivateBelow.minor;
      const nextBelowFloorSince = isBelowFloor ? (wallet.belowFloorSince ?? now) : null;

      if (evaluation.state === wallet.state && wasBelowFloor === isBelowFloor) {
        return evaluation.state;
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await walletRepository.setState(walletId, evaluation.state, nextBelowFloorSince, session);

          if (evaluation.state === WalletState.INACTIVE && wallet.state !== WalletState.INACTIVE) {
            await events.publish(
              {
                type: WalletEvents.SELLER_DEACTIVATED,
                aggregateType: 'wallet',
                aggregateId: walletId,
                payload: { walletId, sellerId: wallet.ownerId, balance: wallet.balance.toStorage() },
              },
              session,
            );
          } else if (
            evaluation.state !== WalletState.INACTIVE &&
            wallet.state === WalletState.INACTIVE
          ) {
            await events.publish(
              {
                type: WalletEvents.SELLER_REACTIVATED,
                aggregateType: 'wallet',
                aggregateId: walletId,
                payload: { walletId, sellerId: wallet.ownerId, balance: wallet.balance.toStorage() },
              },
              session,
            );
          } else if (evaluation.state === WalletState.LOW && wallet.state === WalletState.ACTIVE) {
            await events.publish(
              {
                type: WalletEvents.WALLET_LOW,
                aggregateType: 'wallet',
                aggregateId: walletId,
                payload: { walletId, sellerId: wallet.ownerId, balance: wallet.balance.toStorage() },
              },
              session,
            );
          }
        });
      } finally {
        await session.endSession();
      }

      return evaluation.state;
    },

    /**
     * Reverses a charge. Used when an order is refunded after a dispute.
     *
     * A new, opposite entry — never an edit. The books must be able to show that a charge was
     * made and then undone, not that it never happened (LEDGER.md).
     */
    async reverseForOrder(
      orderId: string,
      reason: string,
      actorId: string,
      /** Omit to reverse the whole charge; supply an amount for a partial refund. */
      partialMinor?: bigint,
    ): Promise<Money> {
      const original = await ledgerRepository.findByKey(`commission:${orderId}`);
      if (!original) throw notFound('Commission entry');

      const reversalKey = `commission-reversal:${orderId}`;
      const existing = await ledgerRepository.findByKey(reversalKey);
      if (existing) return existing.total;

      const amount =
        partialMinor === undefined
          ? original.total
          : Money.of(partialMinor > original.total.minor ? original.total.minor : partialMinor);
      if (!amount.isPositive()) return Money.zero();

      const walletLine = original.lines.find((line) => line.account === Account.SELLER_WALLET);
      if (!walletLine?.walletId) {
        throw new AppError(ErrorCode.LEDGER_ENTRY_UNBALANCED, {
          detail: 'The original commission entry has no wallet line',
        });
      }

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await ledgerRepository.post(
            {
              entryKey: reversalKey,
              type: EntryType.COMMISSION_REVERSAL,
              occurredAt: new Date(),
              lines: [
                {
                  account: Account.PLATFORM_REVENUE_COMMISSION,
                  side: EntrySide.DEBIT,
                  amountMinor: amount.minor,
                },
                {
                  account: Account.SELLER_WALLET,
                  side: EntrySide.CREDIT,
                  amountMinor: amount.minor,
                  walletId: walletLine.walletId,
                },
              ],
              reference: { type: 'order', id: orderId },
              memo: reason,
              createdBy: actorId,
              reversesEntryId: original.id,
            },
            session,
          );
          await events.publish(
            {
              type: WalletEvents.COMMISSION_REVERSED,
              aggregateType: 'order',
              aggregateId: orderId,
              payload: { orderId, amount: amount.toStorage(), reason },
              actorId,
            },
            session,
          );
        });
      } catch (error) {
        // Same reasoning as the charge: a concurrent reversal is the answer, not a fault. A
        // refund posted twice would be the more expensive mistake, and the unique key stops
        // it; this only stops the caller being told it failed.
        if (isDuplicateKey(error)) {
          const reversed = await ledgerRepository.findByKey(reversalKey);
          if (reversed) return reversed.total;
        }
        throw error;
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId,
        action: 'commission.reversed',
        targetType: 'order',
        targetId: orderId,
        reason,
        after: { amount: amount.toStorage(), partial: partialMinor !== undefined },
        critical: true,
      });
      await this.evaluateState(walletLine.walletId);
      return amount;
    },
  };
}

export type CommissionService = ReturnType<typeof createCommissionService>;
