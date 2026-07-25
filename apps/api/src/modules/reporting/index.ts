/**
 * Public surface of the reporting module (ADR-0011 rule 1).
 *
 * Read-only: this module owns no collection and writes nothing. It reads across module
 * boundaries deliberately, which is what a report is, and holds no business rule of its own —
 * a report that decided anything would be a rule nobody could find.
 */
export { createReportingService, type ReportingService } from './services/reporting.service.js';
export {
  createReportingController,
  type ReportingController,
} from './http/reporting.controller.js';
export {
  createAdminReportingRouter,
  createSellerReportingRouter,
} from './http/reporting.routes.js';
export { resolvePeriod, previousPeriod, changeBp, type ReportPeriod } from './services/period.js';
export { summarise, effectiveRateBp, type Statement } from './services/statement.js';
