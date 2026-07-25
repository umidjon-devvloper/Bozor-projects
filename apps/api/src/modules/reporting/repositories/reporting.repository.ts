import mongoose from 'mongoose';
import { OrderStatus } from '@bozorlar/domain';
import type { ReportPeriod } from '../services/period.js';
import type { StatementLine } from '../services/statement.js';
import { QUEUE_STALE_HOURS, SELLER_REPORT_PAGE_SIZE } from '../reporting.constants.js';

/**
 * Every figure in a report, read straight from the collections that own it.
 *
 * These are aggregations rather than reads from a rollup collection, and that is a deliberate
 * choice for this stage rather than an oversight: there is no production traffic yet, a
 * rollup would be a second source of truth to keep correct, and a wrong rollup is far harder
 * to notice than a slow query. Every pipeline here is bounded by the period and hits an
 * indexed field first, so the cost is proportional to the window. When volume makes that
 * insufficient the answer is a nightly rollup written by the worker, and the shape of these
 * pipelines is what it should be built from.
 *
 * Money never passes through a Double. Mongo returns Int64 as `Long`, and every one of them
 * is converted with `BigInt(...toString())` rather than `.toNumber()`.
 */

function db() {
  const connection = mongoose.connection.db;
  if (!connection) throw new Error('Reporting queried before the database was connected');
  return connection;
}

/**
 * Mongo's numeric wire types to an exact bigint.
 *
 * Strict on purpose, and loud when it cannot tell. `Long` and `Decimal128` both stringify
 * losslessly — `.toNumber()` does not — but a blanket `String(value)` would turn an unexpected
 * object into `'[object Object]'` and then into a thrown parse error several frames away, or
 * worse, into a plausible zero. In a report about money, a value that cannot be read exactly
 * must stop the report rather than appear in it.
 */
function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Reporting read a money value that is not an exact integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'object' && 'toString' in value) {
    const text = (value as { toString(): string }).toString();
    if (/^-?\d+$/.test(text)) return BigInt(text);
  }
  throw new Error(`Reporting could not read a money value of type ${typeof value}`);
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

export interface OrderTotals {
  completed: number;
  cancelled: number;
  rejected: number;
  expired: number;
  pending: number;
  gmvMinor: bigint;
  averageOrderMinor: bigint;
}

export interface SellerRow {
  shopId: string;
  orders: number;
  gmvMinor: bigint;
  disputes: number;
}

export interface QueueDepth {
  pending: number;
  stale: number;
  oldestWaitingHours: number | null;
}

export const reportingRepository = {
  /**
   * Order counts and GMV for a window.
   *
   * GMV counts only completed orders. A cancelled order is not revenue by any definition, and
   * counting `PENDING` would make the figure move backwards as orders expire — a metric that
   * can fall on its own is a metric nobody trusts.
   */
  async orderTotals(period: ReportPeriod, shopIds: readonly string[] | null): Promise<OrderTotals> {
    const match: Record<string, unknown> = {
      createdAt: { $gte: period.from, $lt: period.to },
    };
    if (shopIds) match.shopId = { $in: shopIds.map(oid) };

    const rows = await db()
      .collection('orders')
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            gmv: {
              $sum: {
                $cond: [{ $eq: ['$status', OrderStatus.COMPLETED] }, '$totals.grand', 0],
              },
            },
          },
        },
      ])
      .toArray();

    const totals: OrderTotals = {
      completed: 0,
      cancelled: 0,
      rejected: 0,
      expired: 0,
      pending: 0,
      gmvMinor: 0n,
      averageOrderMinor: 0n,
    };

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      switch (row._id) {
        case OrderStatus.COMPLETED:
          totals.completed = count;
          totals.gmvMinor += toBigInt(row.gmv);
          break;
        case OrderStatus.CANCELLED:
          totals.cancelled = count;
          break;
        case OrderStatus.REJECTED:
          totals.rejected = count;
          break;
        case OrderStatus.EXPIRED:
          totals.expired = count;
          break;
        default:
          totals.pending += count;
      }
    }

    if (totals.completed > 0) {
      totals.averageOrderMinor = totals.gmvMinor / BigInt(totals.completed);
    }
    return totals;
  },

  /**
   * Journal lines for a window, optionally for one seller.
   *
   * Returned as lines rather than pre-summed so that the arithmetic lives in a pure function
   * that can be tested. The volume is bounded by the period and a seller posts a handful of
   * entries per completed order.
   */
  async journalLines(
    period: ReportPeriod,
    ownerIds: readonly string[] | null,
  ): Promise<StatementLine[]> {
    const match: Record<string, unknown> = {
      occurredAt: { $gte: period.from, $lt: period.to },
    };
    if (ownerIds) match['lines.ownerId'] = { $in: ownerIds.map(oid) };

    const rows = await db()
      .collection('journal_entries')
      .aggregate([
        { $match: match },
        { $unwind: '$lines' },
        ...(ownerIds
          ? [{ $match: { 'lines.ownerId': { $in: ownerIds.map(oid) } } }]
          : []),
        {
          $project: {
            _id: 0,
            account: '$lines.account',
            side: '$lines.side',
            amountMinor: '$lines.amountMinor',
          },
        },
      ])
      .toArray();

    return rows.map((row) => ({
      account: row.account as StatementLine['account'],
      side: row.side as StatementLine['side'],
      amountMinor: toBigInt(row.amountMinor),
    }));
  },

  /** Sellers ranked by realised sales, with their dispute count for the same window. */
  async sellerLeaderboard(period: ReportPeriod, page: number): Promise<SellerRow[]> {
    interface LeaderboardRow {
      _id: mongoose.Types.ObjectId;
      orders: number;
      gmv: unknown;
      disputeCount: { n: number }[];
    }
    const rows = await db()
      .collection('orders')
      .aggregate([
        {
          $match: {
            createdAt: { $gte: period.from, $lt: period.to },
            status: OrderStatus.COMPLETED,
          },
        },
        { $group: { _id: '$shopId', orders: { $sum: 1 }, gmv: { $sum: '$totals.grand' } } },
        { $sort: { gmv: -1, _id: 1 } },
        { $skip: page * SELLER_REPORT_PAGE_SIZE },
        { $limit: SELLER_REPORT_PAGE_SIZE },
        {
          $lookup: {
            from: 'disputes',
            let: { shop: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$shopId', '$$shop'] },
                  createdAt: { $gte: period.from, $lt: period.to },
                },
              },
              { $count: 'n' },
            ],
            as: 'disputeCount',
          },
        },
      ])
      .toArray() as LeaderboardRow[];

    return rows.map((row) => ({
      shopId: row._id.toString(),
      orders: Number(row.orders ?? 0),
      gmvMinor: toBigInt(row.gmv),
      disputes: Number(row.disputeCount?.[0]?.n ?? 0),
    }));
  },

  /**
   * How deep a queue is, and how long its oldest item has waited.
   *
   * The depth alone says nothing worth acting on. A queue of two where one has waited five
   * days is a worse state than a queue of forty opened this morning, and only the second
   * number distinguishes them.
   */
  async queueDepth(
    collection: string,
    filter: Record<string, unknown>,
    now: Date,
  ): Promise<QueueDepth> {
    const staleBefore = new Date(now.getTime() - QUEUE_STALE_HOURS * 3_600_000);
    const [pending, stale, oldest] = await Promise.all([
      db().collection(collection).countDocuments(filter),
      db()
        .collection(collection)
        .countDocuments({ ...filter, createdAt: { $lt: staleBefore } }),
      db()
        .collection(collection)
        .find(filter)
        .sort({ createdAt: 1 })
        .limit(1)
        .project<{ createdAt: Date }>({ createdAt: 1 })
        .toArray(),
    ]);

    const oldestAt = oldest[0]?.createdAt;
    return {
      pending,
      stale,
      oldestWaitingHours: oldestAt
        ? Math.floor((now.getTime() - oldestAt.getTime()) / 3_600_000)
        : null,
    };
  },

  /** New registrations and the sellers who actually transacted, for the same window. */
  async participation(period: ReportPeriod): Promise<{ newUsers: number; activeSellers: number }> {
    const [newUsers, activeSellers] = await Promise.all([
      db()
        .collection('users')
        .countDocuments({ createdAt: { $gte: period.from, $lt: period.to } }),
      db()
        .collection('orders')
        .distinct('shopId', {
          createdAt: { $gte: period.from, $lt: period.to },
          status: OrderStatus.COMPLETED,
        })
        .then((ids) => ids.length),
    ]);
    return { newUsers, activeSellers };
  },

  /** Shop names for a page of the leaderboard, in one round trip. */
  async shopNames(shopIds: readonly string[]): Promise<Map<string, unknown>> {
    if (shopIds.length === 0) return new Map();
    const rows = await db()
      .collection('shops')
      .find({ _id: { $in: shopIds.map(oid) } })
      .project<{ _id: mongoose.Types.ObjectId; name: unknown }>({ name: 1 })
      .toArray();
    return new Map(rows.map((row) => [row._id.toString(), row.name]));
  },
};
