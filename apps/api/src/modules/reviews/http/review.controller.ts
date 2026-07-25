import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { env } from '@bozorlar/config';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import type { Actor, ReviewService } from '../services/review.service.js';
import type { ReviewRecord } from '../repositories/review.repository.js';
import type { ReportReason } from '../reviews.constants.js';

function requireAuth(req: Request): Actor {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, shopIds: req.auth.shopIds };
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

/**
 * Review serializer.
 *
 * The buyer's identity is a snapshot name and nothing else — no id, no phone, no order number.
 * A review is public, and a public document that links a person to what they bought and when
 * is a privacy leak dressed up as a feature.
 */
function toResponse(review: ReviewRecord, options: { privileged: boolean }) {
  const image = (key: string): string =>
    `${env.CDN_BASE_URL.replace(/\/$/, '')}/${key.replace(/\.[^./]+$/, '_card.webp')}`;

  return {
    id: review.id,
    productId: review.productId,
    shopId: review.shopId,
    rating: review.rating,
    comment: review.comment,
    buyerName: review.buyerName,
    photos: review.photos.map((photo) => ({ url: image(photo.mediaKey), blurhash: photo.blurhash })),
    sellerReply: review.sellerReply
      ? { text: review.sellerReply.text, at: review.sellerReply.at.toISOString() }
      : null,
    createdAt: review.createdAt.toISOString(),
    ...(options.privileged
      ? {
          status: review.status,
          reportCount: review.reportCount,
          orderNo: review.orderNo,
          buyerId: review.buyerId,
        }
      : {}),
  };
}

export function createReviewController(reviews: ReviewService) {
  return {
    // ---- public ----
    async listForProduct(req: Request, res: Response): Promise<void> {
      const productId = requireParam(req.params.id, 'Product');
      const page = await reviews.listForProduct(productId, req.query);
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
      sendCollection(
        res,
        page.items.map((review) => toResponse(review, { privileged: false })),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async productSummary(req: Request, res: Response): Promise<void> {
      const summary = await reviews.summary({ type: 'product', id: requireParam(req.params.id, 'Product') });
      res.setHeader('Cache-Control', 'public, max-age=300');
      sendData(res, summary);
    },

    async listForShop(req: Request, res: Response): Promise<void> {
      const shopId = requireParam(req.params.id, 'Shop');
      const page = await reviews.listForShop(shopId, req.query);
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=600');
      sendCollection(
        res,
        page.items.map((review) => toResponse(review, { privileged: false })),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async shopSummary(req: Request, res: Response): Promise<void> {
      const summary = await reviews.summary({ type: 'shop', id: requireParam(req.params.id, 'Shop') });
      res.setHeader('Cache-Control', 'public, max-age=300');
      sendData(res, summary);
    },

    // ---- buyer ----
    async create(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as {
        orderId: string;
        productId: string;
        rating: number;
        comment?: string;
        photos?: string[];
      };
      const review = await reviews.create({ ...body, actor });
      sendCreated(res, toResponse(review, { privileged: false }));
    },

    async withdraw(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      await reviews.withdraw(requireParam(req.params.id, 'Review'), actor);
      sendNoContent(res);
    },

    async report(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { reason: ReportReason; note?: string };
      const result = await reviews.report(requireParam(req.params.id, 'Review'), body, actor);
      // A repeat report from the same person reports success without doing anything: telling
      // them "you already reported this" invites them to find another account.
      sendData(res, { reported: result.reported });
    },

    // ---- seller ----
    async reply(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const { text } = req.body as { text: string };
      const review = await reviews.reply(requireParam(req.params.id, 'Review'), text, actor);
      sendCreated(res, toResponse(review, { privileged: true }));
    },

    // ---- moderation ----
    async moderate(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { hide: boolean; reason: string };
      const review = await reviews.moderate(requireParam(req.params.id, 'Review'), body, actor.userId);
      sendData(res, toResponse(review, { privileged: true }));
    },

    async reconcile(req: Request, res: Response): Promise<void> {
      const type = req.params.type === 'shop' ? ('shop' as const) : ('product' as const);
      const computed = await reviews.reconcile({ type, id: requireParam(req.params.id, 'Target') });
      sendData(res, { count: computed.count, sumScaled: computed.sumScaled });
    },

    async repair(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const type = req.params.type === 'shop' ? ('shop' as const) : ('product' as const);
      const computed = await reviews.repair(
        { type, id: requireParam(req.params.id, 'Target') },
        actor.userId,
      );
      sendData(res, { repaired: true, count: computed.count });
    },
  };
}

export type ReviewController = ReturnType<typeof createReviewController>;
