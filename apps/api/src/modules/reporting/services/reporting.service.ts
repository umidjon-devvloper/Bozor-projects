import { notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { DisputeStatus } from '@bozorlar/domain';
import { ProductStatus } from '../../catalog/index.js';
import { ApplicationStatus } from '../../onboarding/index.js';
import { reportingRepository } from '../repositories/reporting.repository.js';
import { changeBp, previousPeriod, resolvePeriod, type ReportPeriod } from './period.js';
import { effectiveRateBp, summarise, type Statement } from './statement.js';

/**
 * Reports for the admin panel and for a seller's own dashboard.
 *
 * Read-only by construction: nothing in this module writes, and it owns no collection. That is
 * what lets it read across module boundaries without becoming a second place where business
 * rules live — a report that decided anything would be a rule nobody could find.
 */

export interface OverviewReport {
  period: { from: string; to: string; days: number };
  orders: {
    completed: number;
    cancelled: number;
    rejected: number;
    expired: number;
    pending: number;
    completionRateBp: number | null;
  };
  money: {
    gmvMinor: string;
    averageOrderMinor: string;
    commissionNetMinor: string;
    commissionChargedMinor: string;
    commissionReversedMinor: string;
    topUpMinor: string;
    effectiveRateBp: number | null;
  };
  participation: { newUsers: number; activeSellers: number };
  change: { gmvBp: number | null; commissionBp: number | null };
}

export function createReportingService(deps: { logger: Logger }) {
  const { logger } = deps;

  async function moneyFor(
    period: ReportPeriod,
    ownerIds: readonly string[] | null,
  ): Promise<Statement> {
    return summarise(await reportingRepository.journalLines(period, ownerIds));
  }

  return {
    /**
     * The platform at a glance, with the previous window of equal length for comparison.
     *
     * The comparison is computed rather than stored, so a report for an unusual window — nine
     * days, say — is still compared against the nine days before it rather than against a
     * calendar month that does not line up with it.
     */
    async overview(query: { from?: string; to?: string }, now: Date): Promise<OverviewReport> {
      const period = resolvePeriod(query, now);
      const prior = previousPeriod(period);

      const [orders, statement, participation, priorOrders, priorStatement] = await Promise.all([
        reportingRepository.orderTotals(period, null),
        moneyFor(period, null),
        reportingRepository.participation(period),
        reportingRepository.orderTotals(prior, null),
        moneyFor(prior, null),
      ]);

      const decided = orders.completed + orders.cancelled + orders.rejected + orders.expired;

      logger.debug({ from: period.from, to: period.to }, 'overview report computed');

      return {
        period: {
          from: period.from.toISOString(),
          to: period.to.toISOString(),
          days: period.days,
        },
        orders: {
          completed: orders.completed,
          cancelled: orders.cancelled,
          rejected: orders.rejected,
          expired: orders.expired,
          pending: orders.pending,
          // Against decided orders only. Including those still in flight would report a
          // completion rate that rises on its own as the day's orders settle.
          completionRateBp:
            decided === 0 ? null : Math.round((orders.completed / decided) * 10_000),
        },
        money: {
          gmvMinor: orders.gmvMinor.toString(),
          averageOrderMinor: orders.averageOrderMinor.toString(),
          commissionNetMinor: statement.commissionNetMinor.toString(),
          commissionChargedMinor: statement.commissionChargedMinor.toString(),
          commissionReversedMinor: statement.commissionReversedMinor.toString(),
          topUpMinor: statement.topUpMinor.toString(),
          effectiveRateBp: effectiveRateBp(statement.commissionNetMinor, orders.gmvMinor),
        },
        participation,
        change: {
          gmvBp: changeBp(orders.gmvMinor, priorOrders.gmvMinor),
          commissionBp: changeBp(statement.commissionNetMinor, priorStatement.commissionNetMinor),
        },
      };
    },

    /** Sellers ranked by realised sales, with the dispute rate that qualifies the ranking. */
    async sellers(query: { from?: string; to?: string; page?: number }, now: Date) {
      const period = resolvePeriod(query, now);
      const rows = await reportingRepository.sellerLeaderboard(period, query.page ?? 0);
      const names = await reportingRepository.shopNames(rows.map((row) => row.shopId));

      return {
        period: { from: period.from.toISOString(), to: period.to.toISOString(), days: period.days },
        sellers: rows.map((row) => ({
          shopId: row.shopId,
          name: names.get(row.shopId) ?? null,
          orders: row.orders,
          gmvMinor: row.gmvMinor.toString(),
          disputes: row.disputes,
          // Per completed order, in basis points. The ranking is by sales; this is the number
          // that says whether the ranking should be believed.
          disputeRateBp: row.orders === 0 ? null : Math.round((row.disputes / row.orders) * 10_000),
        })),
      };
    },

    /**
     * What is waiting for a human.
     *
     * Deliberately not a count of everything: these are the three queues where nothing moves
     * until somebody decides. Anything else that accumulates is either automatic or nobody's
     * job, and putting it here would dilute the only screen an administrator checks daily.
     */
    async moderation(now: Date) {
      const [products, applications, disputes] = await Promise.all([
        reportingRepository.queueDepth(
          'products',
          { status: ProductStatus.PENDING_MODERATION, deletedAt: null },
          now,
        ),
        reportingRepository.queueDepth(
          'seller_applications',
          // UNDER_REVIEW counts too: a moderator who opened an application and moved on has
          // not finished with it, and it is still blocking a seller from trading.
          { status: { $in: [ApplicationStatus.SUBMITTED, ApplicationStatus.UNDER_REVIEW] } },
          now,
        ),
        reportingRepository.queueDepth(
          'disputes',
          { status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } },
          now,
        ),
      ]);
      return { products, sellerApplications: applications, disputes };
    },

    /**
     * One seller's statement for a period.
     *
     * `shopIds` is the caller's own set when a seller asks and the target shop's owner when an
     * administrator does. A seller asking about a shop that is not theirs is told it does not
     * exist rather than that they may not see it (ADR-0029): a permission error would confirm
     * the shop exists and had takings.
     */
    async statement(
      input: { ownerId: string; shopIds: readonly string[]; from?: string; to?: string },
      now: Date,
    ) {
      if (input.shopIds.length === 0) throw notFound('Shop');
      const period = resolvePeriod(input, now);

      const [orders, money] = await Promise.all([
        reportingRepository.orderTotals(period, input.shopIds),
        moneyFor(period, [input.ownerId]),
      ]);

      return {
        period: { from: period.from.toISOString(), to: period.to.toISOString(), days: period.days },
        orders: { completed: orders.completed, cancelled: orders.cancelled },
        gmvMinor: orders.gmvMinor.toString(),
        commissionChargedMinor: money.commissionChargedMinor.toString(),
        commissionReversedMinor: money.commissionReversedMinor.toString(),
        commissionNetMinor: money.commissionNetMinor.toString(),
        topUpMinor: money.topUpMinor.toString(),
        adjustmentMinor: money.adjustmentMinor.toString(),
        // Against realised sales, not against the configured rule: the two differ whenever a
        // charge failed or was reversed, and this is the one a seller can check themselves.
        effectiveRateBp: effectiveRateBp(money.commissionNetMinor, orders.gmvMinor),
      };
    },
  };
}

export type ReportingService = ReturnType<typeof createReportingService>;
