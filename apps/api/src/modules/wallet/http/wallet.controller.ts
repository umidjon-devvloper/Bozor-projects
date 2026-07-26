import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { Money } from '@bozorlar/money';
import { Account, EntrySide } from '@bozorlar/domain';
import { sendCreated, sendData } from '../../../http/envelope.js';
import type { WalletService } from '../services/wallet.service.js';
import type { JournalEntryRecord, RuleScope, WalletRecord } from '@bozorlar/ledger';

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function toWalletResponse(wallet: WalletRecord) {
  return {
    id: wallet.id,
    balance: wallet.balance.toDTO(),
    state: wallet.state,
    lowBalanceThreshold: wallet.lowBalanceThreshold.toDTO(),
    deactivateBelow: wallet.deactivateBelow.toDTO(),
    graceHours: wallet.graceHours,
    lifetimeCharged: wallet.lifetimeCharged.toDTO(),
    lifetimeCredited: wallet.lifetimeCredited.toDTO(),
    lastEntryAt: wallet.lastEntryAt?.toISOString() ?? null,
  };
}

/**
 * A statement line, from the seller's point of view.
 *
 * The ledger records both sides of every movement; a seller wants one figure and a sign, so
 * the wallet line is picked out and its side translated into what happened to their money.
 */
function toStatementLine(entry: JournalEntryRecord, walletId: string) {
  const line = entry.lines.find(
    (candidate) => candidate.account === Account.SELLER_WALLET && candidate.walletId === walletId,
  );
  return {
    id: entry.id,
    type: entry.type,
    occurredAt: entry.occurredAt.toISOString(),
    amount: (line?.amount ?? entry.total).toDTO(),
    direction: line?.side === EntrySide.CREDIT ? 'CREDIT' : 'DEBIT',
    memo: entry.memo,
    reference: entry.reference,
  };
}

export function createWalletController(wallet: WalletService) {
  const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'private, no-store');
  };

  return {
    // ---- seller ----
    async myWallet(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      noStore(res);
      sendData(res, toWalletResponse(await wallet.forSeller(auth.userId)));
    },

    async myStatement(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const limit = Math.min(Number(req.query.limit ?? 50), 100);
      const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;
      const result = await wallet.statement(auth.userId, limit, before);
      noStore(res);
      sendData(res, {
        wallet: toWalletResponse(result.wallet),
        entries: result.entries.map((entry) => toStatementLine(entry, result.wallet.id)),
      });
    },

    // ---- admin ----
    async getWallet(req: Request, res: Response): Promise<void> {
      noStore(res);
      sendData(res, toWalletResponse(await wallet.forSeller(requireParam(req.params.sellerId, 'Seller'))));
    },

    async adjust(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      // Present by definition: the idempotency middleware rejects the request without it.
      const requestKey = req.header('idempotency-key') ?? '';
      const body = req.body as {
        sellerId: string;
        amount: string;
        direction: 'CREDIT' | 'DEBIT';
        reason: string;
        approvedBy?: string;
      };
      const updated = await wallet.manualAdjustment({
        sellerId: body.sellerId,
        amount: Money.of(body.amount),
        direction: body.direction,
        reason: body.reason,
        actorId: auth.userId,
        approvedBy: body.approvedBy,
        requestKey,
      });
      noStore(res);
      sendCreated(res, toWalletResponse(updated));
    },

    async setThresholds(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as {
        lowBalanceThreshold: string;
        deactivateBelow: string;
        graceHours: number;
      };
      const updated = await wallet.setThresholds(
        requireParam(req.params.sellerId, 'Seller'),
        {
          lowBalanceThreshold: Money.of(body.lowBalanceThreshold),
          deactivateBelow: Money.of(body.deactivateBelow),
          graceHours: body.graceHours,
        },
        auth.userId,
      );
      noStore(res);
      sendData(res, toWalletResponse(updated));
    },

    async reconcile(req: Request, res: Response): Promise<void> {
      const result = await wallet.reconcile(requireParam(req.params.sellerId, 'Seller'));
      noStore(res);
      sendData(res, {
        stored: result.stored.toDTO(),
        computed: result.computed.toDTO(),
        matches: result.matches,
      });
    },

    async listRules(_req: Request, res: Response): Promise<void> {
      const rules = await wallet.listRules();
      noStore(res);
      sendData(
        res,
        rules.map((rule) => ({
          id: rule.id,
          scope: rule.scope,
          scopeId: rule.scopeId,
          percentBp: rule.percentBp,
          minCharge: rule.minCharge?.toDTO() ?? null,
          maxCharge: rule.maxCharge?.toDTO() ?? null,
          priority: rule.priority,
          effectiveFrom: rule.effectiveFrom.toISOString(),
          effectiveTo: rule.effectiveTo?.toISOString() ?? null,
          note: rule.note,
        })),
      );
    },

    async createRule(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as {
        scope: RuleScope;
        scopeId: string | null;
        percentBp: number;
        minCharge?: string | null;
        maxCharge?: string | null;
        priority: number;
        effectiveFrom: string;
        effectiveTo?: string | null;
        note?: string;
      };
      const rule = await wallet.createRule({
        scope: body.scope,
        scopeId: body.scopeId,
        percentBp: body.percentBp,
        minCharge: body.minCharge ? Money.of(body.minCharge) : null,
        maxCharge: body.maxCharge ? Money.of(body.maxCharge) : null,
        priority: body.priority,
        effectiveFrom: new Date(body.effectiveFrom),
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        note: body.note ?? null,
        actorId: auth.userId,
      });
      noStore(res);
      sendCreated(res, { id: rule.id, percentBp: rule.percentBp, effectiveFrom: rule.effectiveFrom.toISOString() });
    },

    /** Lets an operator see what a rule would charge before committing to it. */
    async previewRule(req: Request, res: Response): Promise<void> {
      const body = req.body as {
        shopId: string;
        marketId: string;
        categoryIds: string[];
        amount: string;
        at?: string;
      };
      const result = await wallet.previewRule({
        at: body.at ? new Date(body.at) : new Date(),
        shopId: body.shopId,
        marketId: body.marketId,
        categoryIds: body.categoryIds,
        amount: Money.of(body.amount),
      });
      noStore(res);
      sendData(res, {
        rule: result.rule
          ? { id: result.rule.id, scope: result.rule.scope, percentBp: result.rule.percentBp }
          : null,
        charge: result.charge?.toDTO() ?? null,
      });
    },
  };
}

export type WalletController = ReturnType<typeof createWalletController>;
