import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { OrderModel } from '../models/order.model.js';
import { CommissionStatus } from '../orders.constants.js';

/**
 * The wallet module's only write path into an order.
 *
 * Commission belongs to the wallet module — it owns the rules and the ledger — but the
 * snapshot lives on the order, because an order has to be able to explain its own charge
 * years later without joining anything (COMMISSION_SPEC.md).
 */
export const orderCommissionWriter = {
  async recordCharged(
    orderId: string,
    input: { ruleId: string; percentBp: number; amountMinor: bigint; journalEntryId: string },
    session: ClientSession,
  ): Promise<void> {
    await OrderModel.updateOne(
      { _id: orderId },
      {
        $set: {
          'commission.ruleId': new Types.ObjectId(input.ruleId),
          'commission.percentBp': input.percentBp,
          'commission.amount': input.amountMinor,
          'commission.status': CommissionStatus.CHARGED,
          'commission.journalEntryId': new Types.ObjectId(input.journalEntryId),
          'commission.chargedAt': new Date(),
        },
      },
      { session },
    );
  },

  /**
   * Marks a charge as failed. The order itself is untouched: it is an agreement between a
   * buyer and a seller, and the platform failing to bill is not their problem (ADR-0033).
   */
  async recordFailed(orderId: string, reason: string): Promise<void> {
    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { 'commission.status': CommissionStatus.FAILED, 'commission.failureReason': reason } },
    );
  },

  /** Orders whose commission has not been settled. Read by the retry job and the admin view. */
  async findUnsettled(limit: number): Promise<
    Array<{
      id: string;
      orderNo: string;
      sellerId: string;
      shopId: string;
      marketId: string;
      totalMinor: bigint;
      createdAt: Date;
      completedAt: Date;
      commissionStatus: string;
    }>
  > {
    const docs = await OrderModel.find({
      status: 'COMPLETED',
      'commission.status': { $in: [CommissionStatus.PENDING, CommissionStatus.FAILED] },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    return docs.map((doc) => ({
      id: doc._id.toString(),
      orderNo: doc.orderNo,
      sellerId: doc.sellerId.toString(),
      shopId: doc.shopId.toString(),
      marketId: doc.marketId.toString(),
      totalMinor: doc.totals.grand,
      createdAt: doc.createdAt,
      completedAt: doc.updatedAt,
      commissionStatus: doc.commission.status,
    }));
  },
};
