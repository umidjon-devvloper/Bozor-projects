import mongoose from 'mongoose';
import { Account, EntrySide } from '@bozorlar/domain';
import { EntryType, ledgerRepository, walletRepository } from '@bozorlar/ledger';
import type { Logger } from '@bozorlar/logger';
import {
  MAX_TOPUP_MINOR,
  MIN_TOPUP_MINOR,
  PaymentPurpose,
  PaymeState,
} from '../payments.constants.js';
import type { PaymentProvider } from '../payments.constants.js';
import {
  paymentTransactionRepository,
  type PaymentRecord,
} from '../repositories/paymentTransaction.repository.js';

/**
 * What actually happens when somebody pays.
 *
 * Provider-agnostic on purpose. Payme and Click disagree about almost everything at the wire —
 * JSON-RPC against form-encoded callbacks, tiyin against decimal som, a state machine against
 * two bare callbacks — but they agree about the only thing that matters here: money arrived
 * for a known account, once, and must be credited exactly once. Both controllers translate
 * their protocol into these four calls and nothing else.
 */

export type TopUpFailure =
  | 'ACCOUNT_NOT_FOUND'
  | 'AMOUNT_TOO_SMALL'
  | 'AMOUNT_TOO_LARGE'
  | 'SELLER_INACTIVE';

export function createPaymentService(deps: { logger: Logger }) {
  const { logger } = deps;

  return {
    /**
     * Whether this account and amount could be paid, without creating anything.
     *
     * Both protocols have a step for this and both mean it: Payme's CheckPerformTransaction
     * and Click's Prepare are asked *before* the customer's card is touched, and answering
     * "yes" to something we will later refuse means taking money we then have to give back.
     */
    async checkTopUp(input: {
      sellerId: string;
      amountMinor: bigint;
    }): Promise<TopUpFailure | null> {
      if (!mongoose.Types.ObjectId.isValid(input.sellerId)) return 'ACCOUNT_NOT_FOUND';
      if (input.amountMinor < MIN_TOPUP_MINOR) return 'AMOUNT_TOO_SMALL';
      if (input.amountMinor > MAX_TOPUP_MINOR) return 'AMOUNT_TOO_LARGE';

      const wallet = await walletRepository.findByOwner(input.sellerId);
      if (!wallet) return 'ACCOUNT_NOT_FOUND';
      return null;
    },

    async find(
      provider: PaymentProvider,
      providerTransactionId: string,
    ): Promise<PaymentRecord | null> {
      return paymentTransactionRepository.findByProviderId(provider, providerTransactionId);
    },

    async create(input: {
      provider: PaymentProvider;
      providerTransactionId: string;
      providerReference: string | null;
      sellerId: string;
      amountMinor: bigint;
      rawAccount: Record<string, unknown>;
    }): Promise<PaymentRecord> {
      return paymentTransactionRepository.create({
        provider: input.provider,
        providerTransactionId: input.providerTransactionId,
        providerReference: input.providerReference,
        purpose: PaymentPurpose.SELLER_TOPUP,
        ownerId: input.sellerId,
        amountMinor: input.amountMinor,
        state: PaymeState.CREATED,
        rawAccount: input.rawAccount,
      });
    },

    /**
     * Credits the wallet, once.
     *
     * The journal entry and the state change are one transaction, and the state change is a
     * compare-and-set from CREATED. Both providers retry every call by design, so the second
     * attempt loses the compare-and-set, posts nothing, and the caller returns the stored
     * answer. Without that, the first retry of the first real payment would double a wallet.
     *
     * `entryKey` is derived from the provider's own transaction id rather than from a clock,
     * so it is stable across retries and the ledger's own uniqueness constraint is a second
     * line of defence behind the first.
     */
    async perform(transaction: PaymentRecord, now: Date): Promise<PaymentRecord | null> {
      const wallet = await walletRepository.ensureFor(transaction.ownerId);
      const session = await mongoose.startSession();
      try {
        let performed = false;
        await session.withTransaction(async () => {
          const entry = await ledgerRepository.post(
            {
              entryKey: `topup:${transaction.provider}:${transaction.providerTransactionId}`,
              type: EntryType.TOP_UP,
              occurredAt: now,
              lines: [
                {
                  account: Account.PLATFORM_CASH,
                  side: EntrySide.DEBIT,
                  amountMinor: transaction.amountMinor,
                },
                {
                  account: Account.SELLER_WALLET,
                  side: EntrySide.CREDIT,
                  amountMinor: transaction.amountMinor,
                  walletId: wallet.id,
                  ownerId: transaction.ownerId,
                },
              ],
              reference: { type: 'payment', id: transaction.id },
              memo: `Top-up via ${transaction.provider}`,
            },
            session,
          );

          performed = await paymentTransactionRepository.markPerformed(
            transaction.id,
            entry.id,
            now,
            PaymeState.CREATED,
            PaymeState.COMPLETED,
            session,
          );

          if (!performed) {
            // Somebody else got there first. Abort so the entry above is not written twice.
            throw new Error('PAYMENT_ALREADY_PERFORMED');
          }
        });

        logger.info(
          { transactionId: transaction.id, provider: transaction.provider },
          'wallet topped up',
        );
        return paymentTransactionRepository.findByProviderId(
          transaction.provider,
          transaction.providerTransactionId,
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'PAYMENT_ALREADY_PERFORMED') {
          return paymentTransactionRepository.findByProviderId(
            transaction.provider,
            transaction.providerTransactionId,
          );
        }
        throw error;
      } finally {
        await session.endSession();
      }
    },

    /**
     * Cancels, and reverses the credit if there was one.
     *
     * A cancellation after a completed payment is a refund, and a refund that only changes a
     * status leaves the wallet holding money the platform no longer has. The reversing entry
     * points at the original through `reversesEntryId`, so the pair is visible in the ledger
     * rather than being two unrelated movements that happen to cancel out.
     */
    async cancel(transaction: PaymentRecord, reason: number, now: Date): Promise<PaymentRecord | null> {
      const nextState =
        transaction.state === PaymeState.COMPLETED
          ? PaymeState.CANCELLED_AFTER_COMPLETE
          : PaymeState.CANCELLED;

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (transaction.state === PaymeState.COMPLETED && transaction.journalEntryId) {
            const wallet = await walletRepository.ensureFor(transaction.ownerId);
            await ledgerRepository.post(
              {
                entryKey: `topup-reversal:${transaction.provider}:${transaction.providerTransactionId}`,
                type: EntryType.TOP_UP,
                occurredAt: now,
                lines: [
                  {
                    account: Account.SELLER_WALLET,
                    side: EntrySide.DEBIT,
                    amountMinor: transaction.amountMinor,
                    walletId: wallet.id,
                    ownerId: transaction.ownerId,
                  },
                  {
                    account: Account.PLATFORM_CASH,
                    side: EntrySide.CREDIT,
                    amountMinor: transaction.amountMinor,
                  },
                ],
                reference: { type: 'payment', id: transaction.id },
                memo: `Top-up reversed via ${transaction.provider}`,
                reversesEntryId: transaction.journalEntryId,
              },
              session,
            );
          }

          /**
           * The same ordering as `perform`: the state moves inside the transaction, and losing
           * the compare-and-set aborts everything above it. Without this the reversal is
           * already in the ledger by the time we discover somebody else cancelled first, and
           * the only thing stopping a second refund is a unique index throwing a duplicate-key
           * error — protection by accident rather than by design.
           */
          const won = await paymentTransactionRepository.markCancelled(
            transaction.id,
            transaction.state,
            nextState,
            reason,
            now,
            session,
          );
          if (!won) throw new Error('PAYMENT_ALREADY_CANCELLED');
        });

        logger.warn(
          { transactionId: transaction.id, provider: transaction.provider, reason },
          'payment cancelled',
        );
        return paymentTransactionRepository.findByProviderId(
          transaction.provider,
          transaction.providerTransactionId,
        );
      } catch (error) {
        // Losing the race is not a failure to report: the transaction is cancelled, which is
        // what the caller asked for, and the provider must receive the stored answer rather
        // than an error that would make it retry a cancellation already carried out.
        if (error instanceof Error && error.message === 'PAYMENT_ALREADY_CANCELLED') {
          return paymentTransactionRepository.findByProviderId(
            transaction.provider,
            transaction.providerTransactionId,
          );
        }
        throw error;
      } finally {
        await session.endSession();
      }
    },

    async history(sellerId: string, limit: number): Promise<PaymentRecord[]> {
      return paymentTransactionRepository.listForOwner(sellerId, limit);
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
