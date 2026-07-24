import type { ClientSession } from 'mongoose';
import { CounterModel } from '../models/counter.model.js';

/**
 * Human-readable order numbers: `BZ-260728-000142`.
 *
 * Read aloud over the phone at a stall, so the format matters: a prefix that identifies the
 * platform, a date that a seller can sort by, and a short sequence. Internal ids stay
 * ObjectIds (DATABASE.md 2.4).
 */
function todayKey(now: Date): string {
  return now.toISOString().slice(2, 10).replace(/-/g, '');
}

async function nextSequence(scope: string, now: Date, session: ClientSession): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { _id: `${scope}:${todayKey(now)}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  ).lean<{ seq: number }>();
  return doc.seq;
}

export async function nextOrderNumber(now: Date, session: ClientSession): Promise<string> {
  const seq = await nextSequence('order', now, session);
  return `BZ-${todayKey(now)}-${String(seq).padStart(6, '0')}`;
}

export async function nextGroupNumber(now: Date, session: ClientSession): Promise<string> {
  const seq = await nextSequence('group', now, session);
  return `BZG-${todayKey(now)}-${String(seq).padStart(6, '0')}`;
}
