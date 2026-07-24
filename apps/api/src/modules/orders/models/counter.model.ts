import { Schema, model, type Model } from 'mongoose';

/**
 * Atomic sequence generator for human-readable order numbers.
 *
 * Keys are per day (`order:260728`) rather than global. A single global document would be a
 * write hotspot at Phase-3 rates, and the daily rollover keeps the sequence short enough to
 * read aloud over the phone (DATABASE.md 2.4).
 */
export interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { collection: 'counters', strict: 'throw', versionKey: false },
);

export const CounterModel: Model<CounterDoc> = model<CounterDoc>('Counter', counterSchema);
