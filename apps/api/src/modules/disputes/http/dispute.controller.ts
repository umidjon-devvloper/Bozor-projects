import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { DisputeOutcome } from '@bozorlar/domain';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import { Permission } from '../../authz/index.js';
import type { Actor, DisputeService } from '../services/dispute.service.js';
import type { DisputeRecord } from '../repositories/dispute.repository.js';
import type { DisputeReason } from '../disputes.constants.js';

function requireAuth(req: Request): Actor {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, shopIds: req.auth.shopIds };
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

/**
 * Dispute serializer.
 *
 * Evidence is returned as signed-URL keys rather than public URLs: dispute photos live in the
 * private bucket, and both parties fetch them through the audited media endpoint. Emitting a
 * public link here would undo that.
 */
function toResponse(dispute: DisputeRecord, options: { privileged: boolean }) {
  return {
    id: dispute.id,
    disputeNo: dispute.disputeNo,
    orderId: dispute.orderId,
    orderNo: dispute.orderNo,
    shopId: dispute.shopId,
    reason: dispute.reason,
    claim: dispute.claim,
    claimedAmount: dispute.claimedAmount?.toDTO() ?? null,
    orderTotal: dispute.orderTotal.toDTO(),
    status: dispute.status,
    evidenceKeys: dispute.evidence.map((item) => item.mediaKey),
    messages: dispute.messages.map((message) => ({
      authorRole: message.authorRole,
      text: message.text,
      at: message.at.toISOString(),
    })),
    sellerResponseDeadline: dispute.sellerResponseDeadline.toISOString(),
    resolution: dispute.resolution
      ? {
          outcome: dispute.resolution.outcome,
          refundAmount: dispute.resolution.refundAmount.toDTO(),
          settlementMethod: dispute.resolution.settlementMethod,
          reason: dispute.resolution.reason,
          decidedAt: dispute.resolution.decidedAt.toISOString(),
        }
      : null,
    createdAt: dispute.createdAt.toISOString(),
    ...(options.privileged
      ? {
          buyerId: dispute.buyerId,
          sellerId: dispute.sellerId,
          assignedTo: dispute.assignedTo,
          commissionReversed: dispute.resolution?.commissionReversed.toDTO() ?? null,
        }
      : {}),
  };
}

export function createDisputeController(disputes: DisputeService) {
  const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'private, no-store');
  };
  const isModerator = (req: Request): boolean =>
    req.auth?.permissions.has(Permission.DISPUTE_READ_ALL) === true;

  return {
    // ---- buyer ----
    async raise(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as {
        orderId: string;
        reason: DisputeReason;
        claim: string;
        claimedAmount?: string;
        evidence?: string[];
      };
      const dispute = await disputes.raise({ ...body, actor });
      noStore(res);
      sendCreated(res, toResponse(dispute, { privileged: false }), `/api/v1/disputes/${dispute.id}`);
    },

    async get(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const dispute = await disputes.get(
        requireParam(req.params.id, 'Dispute'),
        actor,
        isModerator(req),
      );
      noStore(res);
      sendData(res, toResponse(dispute, { privileged: isModerator(req) }));
    },

    async listMine(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const page = await disputes.listForBuyer(req.query as Record<string, unknown>, actor.userId);
      noStore(res);
      sendCollection(
        res,
        page.items.map((dispute) => toResponse(dispute, { privileged: false })),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async addMessage(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { text: string; evidence?: string[] };
      const dispute = await disputes.addBuyerMessage(
        requireParam(req.params.id, 'Dispute'),
        body,
        actor,
      );
      noStore(res);
      sendCreated(res, toResponse(dispute, { privileged: false }));
    },

    async withdraw(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      await disputes.withdraw(requireParam(req.params.id, 'Dispute'), actor);
      sendNoContent(res);
    },

    // ---- seller ----
    async listForShop(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const page = await disputes.listForSeller(req.query as Record<string, unknown>, actor);
      noStore(res);
      sendCollection(
        res,
        page.items.map((dispute) => toResponse(dispute, { privileged: false })),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async respond(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { text: string; evidence?: string[] };
      const dispute = await disputes.respond(requireParam(req.params.id, 'Dispute'), body, actor);
      noStore(res);
      sendCreated(res, toResponse(dispute, { privileged: false }));
    },

    // ---- moderation ----
    async queue(req: Request, res: Response): Promise<void> {
      const page = await disputes.listForModeration(req.query as Record<string, unknown>);
      noStore(res);
      sendCollection(
        res,
        page.items.map((dispute) => toResponse(dispute, { privileged: true })),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async resolve(req: Request, res: Response): Promise<void> {
      const actor = requireAuth(req);
      const body = req.body as { outcome: DisputeOutcome; refundAmount?: string; reason: string };
      const dispute = await disputes.resolve(
        requireParam(req.params.id, 'Dispute'),
        body,
        actor.userId,
      );
      noStore(res);
      sendData(res, toResponse(dispute, { privileged: true }));
    },
  };
}

export type DisputeController = ReturnType<typeof createDisputeController>;
