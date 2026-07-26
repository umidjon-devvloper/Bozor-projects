import { AuditLogModel, type AuditLogDoc } from './audit.model.js';

/**
 * The audit module's data access.
 *
 * Added during the boundary cleanup. The module was two files — a model and a service that
 * queried it directly — which read as a deliberate exception until you notice that every other
 * module in the system puts its queries behind a repository. One inconsistency is a decision;
 * an undocumented one is a thing the next person has to guess about.
 */
export const auditRepository = {
  /**
   * Appends one entry. Audit rows are never updated or deleted, only written.
   *
   * `Partial` because the schema supplies `schemaVersion` and the timestamps; requiring the
   * caller to pass them would make every audit site repeat what the model already knows.
   */
  async insert(doc: Partial<AuditLogDoc>): Promise<void> {
    await AuditLogModel.create(doc);
  },
};
