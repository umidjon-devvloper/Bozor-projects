import type { ClientSession } from 'mongoose';
import { CounterModel } from '../models/counter.model.js';

/**
 * Atomic sequence numbers.
 *
 * One method, because that is all a counter is: an upsert-and-increment that must be atomic or
 * two orders placed in the same second share a number. The session is required rather than
 * optional — a number handed out by a transaction that later rolls back is a gap in the
 * sequence, and the sequence is what a seller reads back to a buyer over the phone.
 */
export const counterRepository = {
  async nextSequence(key: string, session: ClientSession): Promise<number> {
    const doc = await CounterModel.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, session },
    ).lean<{ seq: number }>();
    return doc.seq;
  },
};
