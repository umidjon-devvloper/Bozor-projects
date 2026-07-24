import mongoose, { type ClientSession } from 'mongoose';
import { OrderStatus, canTransition } from '@bozorlar/domain';
import { OrderModel } from '../models/order.model.js';

/**
 * The dispute module's write path into an order.
 *
 * `DISPUTED` and `REFUNDED` have been in the order state machine since it was written, with
 * nothing able to reach them. These are the transitions that close that hole, kept here
 * because the orders module owns its own state (ADR-0011 rule 1).
 */
export const orderDisputeWriter = {
  async forDispute(orderId: string): Promise<{
    id: string;
    orderNo: string;
    buyerId: string;
    sellerId: string;
    shopId: string;
    status: OrderStatus;
    paymentMode: 'CASH_ON_PICKUP' | 'PREPAID_ONLINE';
    totalMinor: bigint;
    disputeDeadline: Date | null;
    commissionAmountMinor: bigint | null;
  } | null> {
    if (!mongoose.Types.ObjectId.isValid(orderId)) return null;
    const doc = await OrderModel.findById(orderId).lean();
    if (!doc) return null;
    return {
      id: doc._id.toString(),
      orderNo: doc.orderNo,
      buyerId: doc.buyerId.toString(),
      sellerId: doc.sellerId.toString(),
      shopId: doc.shopId.toString(),
      status: doc.status,
      paymentMode: doc.paymentMode,
      totalMinor: doc.totals.grand,
      disputeDeadline: doc.disputeDeadline,
      commissionAmountMinor: doc.commission.amount,
    };
  },

  /**
   * Moves an order into dispute.
   *
   * The expected-status filter makes a concurrent auto-completion safe: whichever write lands
   * first wins, and the loser is told the order moved rather than overwriting it.
   */
  async markDisputed(
    orderId: string,
    from: OrderStatus,
    buyerId: string,
    session: ClientSession,
  ): Promise<boolean> {
    if (!canTransition(from, OrderStatus.DISPUTED)) return false;
    const result = await OrderModel.updateOne(
      { _id: orderId, status: from },
      {
        $set: { status: OrderStatus.DISPUTED },
        $push: {
          statusHistory: {
            $each: [
              {
                from,
                to: OrderStatus.DISPUTED,
                at: new Date(),
                by: new mongoose.Types.ObjectId(buyerId),
                actor: 'BUYER',
                reasonCode: null,
                reason: 'Dispute raised',
              },
            ],
            $slice: -50,
          },
        },
      },
      { session },
    );
    return result.modifiedCount === 1;
  },

  /**
   * Settles a disputed order.
   *
   * A refund lands on `REFUNDED`; a dismissal returns the order to `COMPLETED`, because the
   * transaction did in fact complete and the buyer's claim was not upheld.
   */
  async settle(
    orderId: string,
    refunded: boolean,
    moderatorId: string,
    reason: string,
    session: ClientSession,
  ): Promise<boolean> {
    const to = refunded ? OrderStatus.REFUNDED : OrderStatus.COMPLETED;
    const result = await OrderModel.updateOne(
      { _id: orderId, status: OrderStatus.DISPUTED },
      {
        $set: { status: to },
        $push: {
          statusHistory: {
            $each: [
              {
                from: OrderStatus.DISPUTED,
                to,
                at: new Date(),
                by: new mongoose.Types.ObjectId(moderatorId),
                actor: 'ADMIN',
                reasonCode: null,
                reason,
              },
            ],
            $slice: -50,
          },
        },
      },
      { session },
    );
    return result.modifiedCount === 1;
  },
};
