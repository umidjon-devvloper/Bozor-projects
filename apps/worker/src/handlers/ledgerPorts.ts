import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { AuditRecorder, EventPublisher } from '@bozorlar/ledger';

/**
 * The worker's implementations of the ledger's ports.
 *
 * Deliberately the same contract as the API's: the money logic is shared, only the plumbing
 * differs. Events still go through the outbox rather than being dispatched inline, so a
 * commission charge and the notification about it commit together (ADR-0012).
 */
export function createWorkerEventPublisher(): EventPublisher {
  return {
    async publish(event, session): Promise<void> {
      const db = mongoose.connection.db;
      if (!db) throw new Error('No database connection');
      await db.collection('outbox').insertOne(
        {
          eventId: randomUUID(),
          type: event.type,
          version: 1,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
          traceId: null,
          actorId: null,
          actorType: 'SYSTEM',
          occurredAt: new Date(),
          publishedAt: null,
          attempts: 0,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { session },
      );
    },
  };
}

export function createWorkerAuditRecorder(): AuditRecorder {
  return {
    async record(entry): Promise<void> {
      const db = mongoose.connection.db;
      if (!db) return;
      await db.collection('audit_logs').insertOne({
        actorId: entry.actorId ? new mongoose.Types.ObjectId(entry.actorId) : null,
        actorType: 'SYSTEM',
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        before: null,
        after: entry.after ?? null,
        reason: entry.reason ?? null,
        ip: null,
        userAgent: null,
        traceId: null,
        severity: entry.critical === true ? 'CRITICAL' : 'INFO',
        schemaVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
  };
}

/** The worker's write path into an order's commission snapshot. */
export function createWorkerOrderWriter() {
  return {
    async recordCharged(
      orderId: string,
      input: { ruleId: string; percentBp: number; amountMinor: bigint; journalEntryId: string },
      session: mongoose.ClientSession,
    ): Promise<void> {
      const db = mongoose.connection.db;
      if (!db) throw new Error('No database connection');
      await db.collection('orders').updateOne(
        { _id: new mongoose.Types.ObjectId(orderId) },
        {
          $set: {
            'commission.ruleId': new mongoose.Types.ObjectId(input.ruleId),
            'commission.percentBp': input.percentBp,
            'commission.amount': mongoose.mongo.Long.fromBigInt(input.amountMinor),
            'commission.status': 'CHARGED',
            'commission.journalEntryId': new mongoose.Types.ObjectId(input.journalEntryId),
            'commission.chargedAt': new Date(),
          },
        },
        { session },
      );
    },

    async recordFailed(orderId: string, reason: string): Promise<void> {
      const db = mongoose.connection.db;
      if (!db) return;
      await db.collection('orders').updateOne(
        { _id: new mongoose.Types.ObjectId(orderId) },
        { $set: { 'commission.status': 'FAILED', 'commission.failureReason': reason } },
      );
    },
  };
}
