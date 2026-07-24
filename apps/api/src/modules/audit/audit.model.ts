import { Schema, model, type Model, type Types } from 'mongoose';
import { ActorType, AuditSeverity } from '@bozorlar/types';

/** Append-only. Never updated, never deleted (DATABASE.md 2.1). */
export interface AuditLogDoc {
  _id: Types.ObjectId;
  actorId: Types.ObjectId | null;
  actorType: ActorType;
  action: string;
  targetType: string;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  severity: AuditSeverity;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorType: { type: String, enum: Object.values(ActorType), required: true },
    action: { type: String, required: true, maxlength: 100 },
    targetType: { type: String, required: true, maxlength: 50 },
    targetId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null, maxlength: 1000 },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 512 },
    traceId: { type: String, default: null },
    severity: { type: String, enum: Object.values(AuditSeverity), required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: true, collection: 'audit_logs', strict: 'throw' },
);

auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index(
  { severity: 1, createdAt: -1 },
  { partialFilterExpression: { severity: AuditSeverity.CRITICAL } },
);
auditLogSchema.index({ createdAt: -1 });

function blockMutation(next: (error?: Error) => void): void {
  next(new Error('audit_logs is append-only'));
}
auditLogSchema.pre('updateOne', function (next) { blockMutation(next); });
auditLogSchema.pre('updateMany', function (next) { blockMutation(next); });
auditLogSchema.pre('findOneAndUpdate', function (next) { blockMutation(next); });
auditLogSchema.pre('deleteOne', function (next) { blockMutation(next); });

export const AuditLogModel: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
