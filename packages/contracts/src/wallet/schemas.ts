import { z } from 'zod';
import { MoneySchema, ObjectIdSchema } from '../common/primitives.js';

const MinorUnitString = z.string().regex(/^\d{1,19}$/, 'Must be an integer string of minor units');

export const RuleScopeSchema = z.enum(['SHOP', 'MARKET', 'CATEGORY', 'PLATFORM']);
export const WalletStateSchema = z.enum(['ACTIVE', 'LOW', 'INACTIVE']);

/**
 * Commission rules are entered, never edited.
 *
 * There is no update schema on purpose: a rate change is a new rule with a later
 * `effectiveFrom`, which is what keeps completed orders priced at the rate they were placed
 * under (ADR-0033).
 */
export const CreateCommissionRuleRequestSchema = z
  .object({
    scope: RuleScopeSchema,
    scopeId: ObjectIdSchema.nullable().default(null),
    // Basis points: 300 is 3.00%. Integers only, so a rate is never a float.
    percentBp: z.number().int().min(0).max(10_000),
    minCharge: MinorUnitString.nullable().optional(),
    maxCharge: MinorUnitString.nullable().optional(),
    priority: z.number().int().min(0).max(1000).default(0),
    effectiveFrom: z.string().datetime(),
    effectiveTo: z.string().datetime().nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const ManualAdjustmentRequestSchema = z
  .object({
    sellerId: ObjectIdSchema,
    amount: MinorUnitString,
    direction: z.enum(['CREDIT', 'DEBIT']),
    // Free text, required, and long enough to be an explanation rather than a shrug.
    reason: z.string().trim().min(10).max(500),
    approvedBy: ObjectIdSchema.optional(),
  })
  .strict();

export const SetWalletThresholdsRequestSchema = z
  .object({
    lowBalanceThreshold: MinorUnitString,
    deactivateBelow: MinorUnitString,
    graceHours: z.number().int().min(0).max(720),
  })
  .strict();

export const PreviewCommissionRequestSchema = z
  .object({
    shopId: ObjectIdSchema,
    marketId: ObjectIdSchema,
    categoryIds: z.array(ObjectIdSchema).max(10).default([]),
    amount: MinorUnitString,
    at: z.string().datetime().optional(),
  })
  .strict();

export const WalletResponseSchema = z.object({
  id: ObjectIdSchema,
  balance: MoneySchema,
  state: WalletStateSchema,
  lowBalanceThreshold: MoneySchema,
  lifetimeCharged: MoneySchema,
  lifetimeCredited: MoneySchema,
});

export const JournalEntryResponseSchema = z.object({
  id: ObjectIdSchema,
  type: z.string(),
  occurredAt: z.string().datetime(),
  amount: MoneySchema,
  direction: z.enum(['CREDIT', 'DEBIT']),
  memo: z.string().nullable(),
  reference: z.object({ type: z.string(), id: z.string() }).nullable(),
});
