import { Schema, model, type Model, type Types } from 'mongoose';
import { RuleScope } from '../constants.js';

/**
 * A commission rate, effective-dated (ADR-0033).
 *
 * Rules are never edited and never deleted — a new rule with a later `effectiveFrom`
 * supersedes an old one. That is what makes "the rate in force when this order was placed"
 * a question with a permanent answer, and it is why changing the rate cannot reprice history.
 */
export interface CommissionRuleDoc {
  _id: Types.ObjectId;
  scope: RuleScope;
  /** Null for PLATFORM; the shop, market or category id otherwise. */
  scopeId: Types.ObjectId | null;
  percentBp: number;
  minChargeMinor: bigint | null;
  maxChargeMinor: bigint | null;
  priority: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
  createdBy: Types.ObjectId;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const commissionRuleSchema = new Schema<CommissionRuleDoc>(
  {
    scope: { type: String, enum: Object.values(RuleScope), required: true },
    scopeId: { type: Schema.Types.ObjectId, default: null },
    // Basis points: 300 is 3.00%. Integers only, so a rate can never be 2.9999999999999996.
    percentBp: { type: Number, required: true, min: 0, max: 10_000 },
    minChargeMinor: { type: BigInt, default: null },
    maxChargeMinor: { type: BigInt, default: null },
    priority: { type: Number, required: true, default: 0, min: 0, max: 1000 },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    note: { type: String, default: null, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'commission_rules', strict: 'throw' },
);

// Resolution reads by scope and date; the index mirrors that exactly.
commissionRuleSchema.index({ scope: 1, scopeId: 1, effectiveFrom: -1 });
commissionRuleSchema.index({ effectiveFrom: -1, effectiveTo: 1 });

commissionRuleSchema.pre('validate', function enforceInvariants(next) {
  if (this.scope === RuleScope.PLATFORM && this.scopeId !== null) {
    next(new Error('A PLATFORM rule must not name a scopeId'));
    return;
  }
  if (this.scope !== RuleScope.PLATFORM && this.scopeId === null) {
    next(new Error(`A ${this.scope} rule must name the ${this.scope.toLowerCase()} it applies to`));
    return;
  }
  if (this.effectiveTo !== null && this.effectiveTo <= this.effectiveFrom) {
    next(new Error('effectiveTo must be after effectiveFrom'));
    return;
  }
  if (
    this.minChargeMinor !== null &&
    this.maxChargeMinor !== null &&
    this.maxChargeMinor < this.minChargeMinor
  ) {
    next(new Error('maxCharge must not be below minCharge'));
    return;
  }
  next();
});

function blockMutation(next: (error?: Error) => void): void {
  // Editing a rate in place would silently reprice every order it had already been applied to.
  next(new Error('commission_rules is append-only; supersede a rule with a new one'));
}
commissionRuleSchema.pre('updateOne', function (next) { blockMutation(next); });
commissionRuleSchema.pre('findOneAndUpdate', function (next) { blockMutation(next); });
commissionRuleSchema.pre('deleteOne', function (next) { blockMutation(next); });

export const CommissionRuleModel: Model<CommissionRuleDoc> = model<CommissionRuleDoc>(
  'CommissionRule',
  commissionRuleSchema,
);
