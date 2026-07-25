import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { sendData } from '../../../http/envelope.js';
import type { ReportingService } from '../services/reporting.service.js';

function requireAuth(req: Request): { userId: string; shopIds: readonly string[] } {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, shopIds: req.auth.shopIds };
}

export function createReportingController(reporting: ReportingService) {
  return {
    overview: async (req: Request, res: Response): Promise<void> => {
      const query = req.validatedQuery as { from?: string; to?: string };
      sendData(res, await reporting.overview(query, new Date()));
    },

    sellers: async (req: Request, res: Response): Promise<void> => {
      const query = req.validatedQuery as { from?: string; to?: string; page: number };
      sendData(res, await reporting.sellers(query, new Date()));
    },

    moderation: async (_req: Request, res: Response): Promise<void> => {
      sendData(res, await reporting.moderation(new Date()));
    },

    /**
     * The seller's own statement.
     *
     * The shop set comes from the token, never from the query. A seller cannot ask about
     * somebody else's takings because there is no parameter through which to ask.
     */
    ownStatement: async (req: Request, res: Response): Promise<void> => {
      const actor = requireAuth(req);
      const query = req.validatedQuery as { from?: string; to?: string };
      sendData(
        res,
        await reporting.statement(
          { ownerId: actor.userId, shopIds: actor.shopIds, ...query },
          new Date(),
        ),
      );
    },
  };
}

export type ReportingController = ReturnType<typeof createReportingController>;
