import mongoose from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { Money } from '@bozorlar/money';
import { Account, EntrySide } from '@bozorlar/domain';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import { outboxService } from '../../outbox/index.js';
import type { AuditService } from '../../audit/index.js';
import {
  commissionRuleRepository,
  ledgerRepository,
  walletRepository,
  DUAL_CONTROL_THRESHOLD_MINOR,
  EntryType,
  MAX_MANUAL_ADJUSTMENT_MINOR,
  WalletEvents,
  type CommissionRuleRecord,
  type CommissionService,
  type JournalEntryRecord,
  type RuleScope,
  type WalletRecord,
} from '@bozorlar/ledger';

export function createWalletService(deps: {
  commission: CommissionService;
  audit: AuditService;
  logger: Logger;
}) {
  const { commission, audit, logger } = deps;

  return {
    async forSeller(sellerId: string): Promise<WalletRecord> {
      return walletRepository.ensureFor(sellerId);
    },

    async statement(
      sellerId: string,
      limit: number,
      before?: Date,
    ): Promise<{ wallet: WalletRecord; entries: JournalEntryRecord[] }> {
      const wallet = await walletRepository.ensureFor(sellerId);
      return { wallet, entries: await ledgerRepository.statement(wallet.id, limit, before) };
    },

    /**
     * Credits or debits a wallet by hand.
     *
     * The only way money enters a wallet until the payments module exists, and permanently the
     * way corrections and goodwill are applied. Every one is audited at CRITICAL with a
     * mandatory reason, and anything large enough to matter needs a second administrator.
     */
    async manualAdjustment(input: {
      sellerId: string;
      amount: Money;
      direction: 'CREDIT' | 'DEBIT';
      reason: string;
      actorId: string;
      approvedBy?: string | undefined;
    }): Promise<WalletRecord> {
      if (!input.amount.isPositive()) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: 'A manual adjustment must be a positive amount; use direction to choose the sign',
        });
      }
      if (input.amount.minor > MAX_MANUAL_ADJUSTMENT_MINOR) {
        throw new AppError(ErrorCode.MONEY_INVALID_AMOUNT, {
          detail: 'This adjustment exceeds the maximum a single entry may move',
        });
      }
      if (input.amount.minor >= DUAL_CONTROL_THRESHOLD_MINOR) {
        if (!input.approvedBy) {
          throw new AppError(ErrorCode.PERM_DUAL_CONTROL_REQUIRED, {
            detail: 'An adjustment of this size needs a second administrator to approve it',
            params: { threshold: DUAL_CONTROL_THRESHOLD_MINOR.toString() },
          });
        }
        if (input.approvedBy === input.actorId) {
          // Otherwise dual control is one person clicking twice.
          throw new AppError(ErrorCode.PERM_DUAL_CONTROL_REQUIRED, {
            detail: 'The approver must be a different administrator',
          });
        }
      }

      const wallet = await walletRepository.ensureFor(input.sellerId);
      const isCredit = input.direction === 'CREDIT';
      const entryKey = `manual:${input.direction.toLowerCase()}:${wallet.id}:${Date.now()}`;

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await ledgerRepository.post(
            {
              entryKey,
              type: isCredit ? EntryType.MANUAL_CREDIT : EntryType.MANUAL_DEBIT,
              occurredAt: new Date(),
              lines: isCredit
                ? [
                    { account: Account.PLATFORM_ADJUSTMENT, side: EntrySide.DEBIT, amountMinor: input.amount.minor },
                    {
                      account: Account.SELLER_WALLET,
                      side: EntrySide.CREDIT,
                      amountMinor: input.amount.minor,
                      walletId: wallet.id,
                      ownerId: input.sellerId,
                    },
                  ]
                : [
                    {
                      account: Account.SELLER_WALLET,
                      side: EntrySide.DEBIT,
                      amountMinor: input.amount.minor,
                      walletId: wallet.id,
                      ownerId: input.sellerId,
                    },
                    { account: Account.PLATFORM_ADJUSTMENT, side: EntrySide.CREDIT, amountMinor: input.amount.minor },
                  ],
              reference: { type: 'manual', id: input.actorId },
              memo: input.reason,
              createdBy: input.actorId,
            },
            session,
          );

          await outboxService.publish(
            {
              type: isCredit ? WalletEvents.WALLET_CREDITED : WalletEvents.WALLET_DEBITED,
              aggregateType: 'wallet',
              aggregateId: wallet.id,
              payload: {
                walletId: wallet.id,
                sellerId: input.sellerId,
                amount: input.amount.toStorage(),
                reason: input.reason,
              },
              actorId: input.actorId,
              actorType: ActorType.ADMIN,
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }

      await audit.record({
        actorId: input.actorId,
        actorType: ActorType.ADMIN,
        action: isCredit ? 'wallet.manual_credit' : 'wallet.manual_debit',
        targetType: 'wallet',
        targetId: wallet.id,
        reason: input.reason,
        after: {
          sellerId: input.sellerId,
          amount: input.amount.toStorage(),
          approvedBy: input.approvedBy ?? null,
        },
        severity: AuditSeverity.CRITICAL,
      });

      await commission.evaluateState(wallet.id);
      logger.warn(
        { walletId: wallet.id, direction: input.direction, amount: input.amount.toStorage() },
        'manual wallet adjustment',
      );

      const updated = await walletRepository.findById(wallet.id);
      if (!updated) throw notFound('Wallet');
      return updated;
    },

    async setThresholds(
      sellerId: string,
      input: { lowBalanceThreshold: Money; deactivateBelow: Money; graceHours: number },
      actorId: string,
    ): Promise<WalletRecord> {
      const wallet = await walletRepository.ensureFor(sellerId);
      const updated = await walletRepository.setThresholds(wallet.id, {
        lowBalanceThresholdMinor: input.lowBalanceThreshold.minor,
        deactivateBelowMinor: input.deactivateBelow.minor,
        graceHours: input.graceHours,
      });
      if (!updated) throw notFound('Wallet');

      await audit.record({
        actorId,
        actorType: ActorType.ADMIN,
        action: 'wallet.thresholds_changed',
        targetType: 'wallet',
        targetId: wallet.id,
        before: {
          lowBalanceThreshold: wallet.lowBalanceThreshold.toStorage(),
          deactivateBelow: wallet.deactivateBelow.toStorage(),
          graceHours: wallet.graceHours,
        },
        after: {
          lowBalanceThreshold: input.lowBalanceThreshold.toStorage(),
          deactivateBelow: input.deactivateBelow.toStorage(),
          graceHours: input.graceHours,
        },
        severity: AuditSeverity.WARNING,
      });
      await commission.evaluateState(wallet.id);
      return updated;
    },

    /**
     * Recomputes a wallet from the journal and reports any divergence.
     *
     * The materialised balance is a cache; this is what proves the cache is honest. It does
     * not repair silently — a mismatch means a write escaped its transaction, and quietly
     * correcting the symptom would hide the cause.
     */
    async reconcile(sellerId: string): Promise<{ stored: Money; computed: Money; matches: boolean }> {
      const wallet = await walletRepository.findByOwner(sellerId);
      if (!wallet) throw notFound('Wallet');

      const computed = Money.of(await ledgerRepository.recomputeBalance(wallet.id));
      const matches = computed.equals(wallet.balance);
      if (!matches) {
        logger.error(
          { walletId: wallet.id, stored: wallet.balance.toStorage(), computed: computed.toStorage() },
          'wallet balance diverges from the ledger',
        );
        await audit.record({
          actorType: ActorType.SYSTEM,
          action: 'wallet.reconciliation_mismatch',
          targetType: 'wallet',
          targetId: wallet.id,
          after: { stored: wallet.balance.toStorage(), computed: computed.toStorage() },
          severity: AuditSeverity.CRITICAL,
        });
      }
      return { stored: wallet.balance, computed, matches };
    },

    // ---- commission rules ----
    async listRules(): Promise<CommissionRuleRecord[]> {
      return commissionRuleRepository.list();
    },

    async createRule(input: {
      scope: RuleScope;
      scopeId: string | null;
      percentBp: number;
      minCharge: Money | null;
      maxCharge: Money | null;
      priority: number;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      note: string | null;
      actorId: string;
    }): Promise<CommissionRuleRecord> {
      // Backdating would reprice orders already completed under the old rate, which is
      // exactly what effective dating exists to prevent (ADR-0033).
      if (input.effectiveFrom.getTime() < Date.now() - 60_000) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          detail: 'A commission rule cannot take effect in the past',
          errors: [{ field: 'effectiveFrom', code: 'MUST_NOT_BE_BACKDATED' }],
        });
      }

      const rule = await commissionRuleRepository.create({
        scope: input.scope,
        scopeId: input.scopeId,
        percentBp: input.percentBp,
        minChargeMinor: input.minCharge?.minor ?? null,
        maxChargeMinor: input.maxCharge?.minor ?? null,
        priority: input.priority,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        note: input.note,
        createdBy: input.actorId,
      });

      await audit.record({
        actorId: input.actorId,
        actorType: ActorType.ADMIN,
        action: 'commission.rule_created',
        targetType: 'commission_rule',
        targetId: rule.id,
        after: {
          scope: rule.scope,
          scopeId: rule.scopeId,
          percentBp: rule.percentBp,
          effectiveFrom: rule.effectiveFrom.toISOString(),
        },
        severity: AuditSeverity.CRITICAL,
      });
      logger.warn({ ruleId: rule.id, percentBp: rule.percentBp }, 'commission rule created');
      return rule;
    },

    async previewRule(input: {
      at: Date;
      shopId: string;
      marketId: string;
      categoryIds: string[];
      amount: Money;
    }): Promise<{ rule: CommissionRuleRecord | null; charge: Money | null }> {
      const rule = await commissionRuleRepository.resolve(input);
      if (!rule) return { rule: null, charge: null };
      return {
        rule,
        charge: input.amount.percentBp(rule.percentBp).clamp(rule.minCharge, rule.maxCharge),
      };
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
