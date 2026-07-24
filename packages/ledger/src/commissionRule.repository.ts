import { Types } from 'mongoose';
import { Money } from '@bozorlar/money';
import { CommissionRuleModel, type CommissionRuleDoc } from './models/commissionRule.model.js';
import { SCOPE_SPECIFICITY, type RuleScope } from './constants.js';

export interface CommissionRuleRecord {
  id: string;
  scope: RuleScope;
  scopeId: string | null;
  percentBp: number;
  minCharge: Money | null;
  maxCharge: Money | null;
  priority: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
  createdAt: Date;
}

function toRecord(doc: CommissionRuleDoc): CommissionRuleRecord {
  return {
    id: doc._id.toString(),
    scope: doc.scope,
    scopeId: doc.scopeId?.toString() ?? null,
    percentBp: doc.percentBp,
    minCharge: doc.minChargeMinor === null ? null : Money.of(doc.minChargeMinor),
    maxCharge: doc.maxChargeMinor === null ? null : Money.of(doc.maxChargeMinor),
    priority: doc.priority,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo,
    note: doc.note,
    createdAt: doc.createdAt,
  };
}

export const commissionRuleRepository = {
  async create(input: {
    scope: RuleScope;
    scopeId: string | null;
    percentBp: number;
    minChargeMinor: bigint | null;
    maxChargeMinor: bigint | null;
    priority: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    note: string | null;
    createdBy: string;
  }): Promise<CommissionRuleRecord> {
    const doc = await CommissionRuleModel.create({
      ...input,
      scopeId: input.scopeId ? new Types.ObjectId(input.scopeId) : null,
      createdBy: new Types.ObjectId(input.createdBy),
    });
    return toRecord(doc.toObject<CommissionRuleDoc>());
  },

  async findById(id: string): Promise<CommissionRuleRecord | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await CommissionRuleModel.findById(id).lean<CommissionRuleDoc>();
    return doc ? toRecord(doc) : null;
  },

  async list(): Promise<CommissionRuleRecord[]> {
    const docs = await CommissionRuleModel.find({}).sort({ effectiveFrom: -1 }).lean<CommissionRuleDoc[]>();
    return docs.map(toRecord);
  },

  /**
   * The rule in force for a given order, at the moment that order was created (ADR-0033).
   *
   * `at` is the order's own creation timestamp, never the clock, which is what makes the
   * answer permanent: resolving the same order tomorrow returns the same rate it would have
   * returned at the time, even if the platform has since repriced.
   *
   * Candidates are filtered by effective window in the query and ranked in memory — the set is
   * a handful of rows, and doing it here keeps the precedence rule readable in one place
   * rather than encoded in an aggregation pipeline.
   */
  async resolve(input: {
    at: Date;
    shopId: string;
    marketId: string;
    categoryIds: readonly string[];
  }): Promise<CommissionRuleRecord | null> {
    const scopeIds = [
      new Types.ObjectId(input.shopId),
      new Types.ObjectId(input.marketId),
      ...input.categoryIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)),
    ];

    const docs = await CommissionRuleModel.find({
      effectiveFrom: { $lte: input.at },
      $and: [{ $or: [{ effectiveTo: null }, { effectiveTo: { $gt: input.at } }] }],
      $or: [{ scope: 'PLATFORM' }, { scopeId: { $in: scopeIds } }],
    }).lean<CommissionRuleDoc[]>();

    if (docs.length === 0) return null;

    const ranked = docs.sort((a, b) => {
      const specificity = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope];
      if (specificity !== 0) return specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    });
    const winner = ranked[0];
    return winner ? toRecord(winner) : null;
  },
};
