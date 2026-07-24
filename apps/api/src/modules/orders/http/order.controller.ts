import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import { CancelActor } from '@bozorlar/domain';
import type { Locale } from '@bozorlar/types';
import { sendCollection, sendCreated, sendData } from '../../../http/envelope.js';
import type { Actor, OrderService } from '../services/order.service.js';
import type { CancelReasonCode } from '../orders.constants.js';
import { toGroupResponse, toOrderResponse, type ViewOptions } from './mappers.js';

function requireAuth(req: Request): Actor {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, shopIds: req.auth.shopIds };
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function options(req: Request, isSeller: boolean): ViewOptions {
  return { locale: req.locale as Locale, cdnBaseUrl: env.CDN_BASE_URL, isSeller };
}

export function createOrderController(orders: OrderService) {
  /** Orders are personal and their state changes constantly; never cache them. */
  const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'private, no-store');
  };

  return {
    // ---- buyer ----
    async create(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const { quoteId, note } = req.body as { quoteId: string; note?: string };
      const result = await orders.createFromQuote({
        quoteId,
        buyerId: actor.userId,
        ...(note !== undefined ? { note } : {}),
      });
      noStore(res);
      sendCreated(
        res,
        {
          groupId: result.groupId,
          groupNo: result.groupNo,
          orders: result.orders.map((order) => toOrderResponse(order, options(req, false))),
        },
        `/api/v1/order-groups/${result.groupId}`,
      );
    },

    async list(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const page = await orders.listForBuyer(req.query as Record<string, unknown>, actor.userId);
      noStore(res);
      sendCollection(
        res,
        page.items.map((order) => toOrderResponse(order, options(req, false))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async get(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.getForBuyer(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, false)));
    },

    async getGroup(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const result = await orders.getGroup(requireParam(req.params.id, 'Order group'), actor);
      noStore(res);
      sendData(res, toGroupResponse(result.group, result.orders, options(req, false)));
    },

    async cancel(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { reasonCode: CancelReasonCode; reason?: string };
      const order = await orders.cancel(
        requireParam(req.params.id, 'Order'),
        actor,
        CancelActor.BUYER,
        body,
      );
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, false)));
    },

    async confirm(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.confirm(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, false)));
    },

    async pickupCode(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const result = await orders.pickupCode(requireParam(req.params.id, 'Order'), actor);
      // A bearer credential for somebody's shopping; it must not sit in a proxy cache.
      noStore(res);
      sendData(res, result);
    },

    async respondToAdjustment(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const { approved } = req.body as { approved: boolean };
      const order = await orders.respondToAdjustment(
        requireParam(req.params.id, 'Order'),
        actor,
        approved,
      );
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, false)));
    },

    // ---- seller ----
    async sellerList(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const page = await orders.listForSeller(req.query as Record<string, unknown>, actor);
      noStore(res);
      sendCollection(
        res,
        page.items.map((order) => toOrderResponse(order, options(req, true))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async sellerGet(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.getForSeller(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async accept(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.accept(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async reject(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { reasonCode: CancelReasonCode; reason: string };
      const order = await orders.reject(requireParam(req.params.id, 'Order'), actor, body);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async preparing(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.startPreparing(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async ready(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const order = await orders.markReady(requireParam(req.params.id, 'Order'), actor);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async adjust(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const { lines } = req.body as { lines: Array<{ lineId: string; confirmedQty: string }> };
      const result = await orders.proposeAdjustment(requireParam(req.params.id, 'Order'), actor, lines);
      noStore(res);
      sendData(res, {
        ...toOrderResponse(result.order, options(req, true)),
        requiresBuyerApproval: result.requiresBuyerApproval,
      });
    },

    async verifyPickup(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const { code } = req.body as { code: string };
      const order = await orders.verifyPickup(requireParam(req.params.id, 'Order'), actor, code);
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },

    async sellerCancel(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { reasonCode: CancelReasonCode; reason?: string };
      const order = await orders.cancel(
        requireParam(req.params.id, 'Order'),
        actor,
        CancelActor.SELLER,
        body,
      );
      noStore(res);
      sendData(res, toOrderResponse(order, options(req, true)));
    },
  };
}

export type OrderController = ReturnType<typeof createOrderController>;
