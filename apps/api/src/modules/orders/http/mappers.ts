import { OrderStatus, cancelRule, CancelActor } from '@bozorlar/domain';
import { resolveLocalized, type Locale, type LocalizedText } from '@bozorlar/types';
import type { OrderGroupRecord, OrderRecord } from '../repositories/order.repository.js';

export interface ViewOptions {
  locale: Locale;
  cdnBaseUrl: string;
  /** True for the shop's own members and for admins. */
  isSeller: boolean;
}

const text = (value: LocalizedText, options: ViewOptions): string =>
  resolveLocalized(value, options.locale);

/**
 * Order serializer.
 *
 * `canCancel` and `canConfirm` come from the same cancellation matrix the service enforces,
 * so a button the client renders is a button the API will honour — rather than the two
 * drifting into a UI that offers actions the server refuses.
 */
export function toOrderResponse(order: OrderRecord, options: ViewOptions) {
  const actor = options.isSeller ? CancelActor.SELLER : CancelActor.BUYER;
  return {
    id: order.id,
    orderNo: order.orderNo,
    groupId: order.groupId,
    status: order.status,
    shop: {
      id: order.shopId,
      name: text(order.shopSnapshot.name, options),
      marketName: text(order.shopSnapshot.marketName, options),
      sectionCode: order.shopSnapshot.sectionCode,
      stallNo: order.shopSnapshot.stallNo,
      // The seller's number reaches the buyer only once the order is live, and the buyer's
      // reaches the seller only after acceptance (API.md Part 4).
      phone:
        order.status === OrderStatus.PENDING && !options.isSeller ? null : order.shopSnapshot.phone,
    },
    lines: order.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      name: text(line.productName, options),
      slug: line.productSlug,
      imageUrl: line.imageKey
        ? `${options.cdnBaseUrl.replace(/\/$/, '')}/${line.imageKey.replace(/\.[^./]+$/, '_thumb.webp')}`
        : null,
      unit: line.unit,
      unitPrice: line.unitPrice.toDTO(),
      orderedQty: line.orderedQty.toDTO(),
      confirmedQty: line.confirmedQty?.toDTO() ?? null,
      lineTotal: line.lineTotal.toDTO(),
      tolerancePercent: line.tolerancePercent,
      adjustmentStatus: line.adjustmentStatus,
    })),
    totals: {
      items: order.totals.items.toDTO(),
      adjustment: order.totals.adjustment.toDTO(),
      discount: order.totals.discount.toDTO(),
      grand: order.totals.grand.toDTO(),
    },
    paymentMode: order.paymentMode,
    pickupWindow: order.pickupWindow
      ? { from: order.pickupWindow.from.toISOString(), to: order.pickupWindow.to.toISOString() }
      : null,
    acceptDeadline: order.acceptDeadline?.toISOString() ?? null,
    autoCompleteAt: order.autoCompleteAt?.toISOString() ?? null,
    disputeDeadline: order.disputeDeadline?.toISOString() ?? null,
    hasAdjustment: order.hasAdjustment,
    cancelledBy: order.cancelledBy,
    cancelReasonCode: order.cancelReasonCode,
    cancelReason: order.cancelReason,
    note: order.note,
    canCancel: cancelRule(order.status, actor).allowed,
    canConfirm: !options.isSeller && order.status === OrderStatus.PICKED_UP,
    canDispute: !options.isSeller && order.status === OrderStatus.COMPLETED,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    ...(options.isSeller
      ? {
          // Contact details reach the seller only after they have taken the order on.
          buyer:
            order.status === OrderStatus.PENDING
              ? { name: order.buyerSnapshot.name }
              : order.buyerSnapshot,
          commissionStatus: order.commissionStatus,
          commissionAmount: order.commissionAmount?.toDTO() ?? null,
          pickupCodeAttempts: order.pickupCodeAttempts,
          statusHistory: order.statusHistory.map((change) => ({
            from: change.from,
            to: change.to,
            at: change.at.toISOString(),
            actor: change.actor,
            reasonCode: change.reasonCode,
          })),
        }
      : {}),
  };
}

export function toGroupResponse(
  group: OrderGroupRecord,
  orders: OrderRecord[],
  options: ViewOptions,
) {
  return {
    id: group.id,
    groupNo: group.groupNo,
    status: group.derivedStatus,
    paymentMode: group.paymentMode,
    totals: {
      items: group.totals.items.toDTO(),
      discount: group.totals.discount.toDTO(),
      grand: group.totals.grand.toDTO(),
    },
    orders: orders.map((order) => toOrderResponse(order, options)),
    createdAt: group.createdAt.toISOString(),
  };
}
