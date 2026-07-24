import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import type { Locale } from '@bozorlar/types';
import { sendCollection, sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import { Permission } from '../../authz/index.js';
import type { OnboardingService, SubmitApplicationCommand } from '../services/onboarding.service.js';
import { toApplicationResponse, type ViewOptions } from './mappers.js';

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return req.auth;
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

function viewOptions(req: Request, privileged: boolean): ViewOptions {
  return { locale: req.locale as Locale, raw: req.query.raw === 'true', privileged };
}

export function createOnboardingController(onboarding: OnboardingService) {
  return {
    // ---- applicant ----
    async submit(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as Omit<SubmitApplicationCommand, 'userId'>;
      const application = await onboarding.submit({ ...body, userId: auth.userId });
      sendCreated(
        res,
        toApplicationResponse(application, viewOptions(req, false)),
        `/api/v1/seller/applications/${application.id}`,
      );
    },

    async resubmit(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as Omit<SubmitApplicationCommand, 'userId'>;
      const application = await onboarding.resubmit(requireParam(req.params.id, 'Application'), {
        ...body,
        userId: auth.userId,
      });
      sendData(res, toApplicationResponse(application, viewOptions(req, false)));
    },

    async getMine(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const application = await onboarding.getMine(auth.userId);
      // No application is a legitimate state for a buyer, not a 404 on a missing resource.
      sendData(res, application ? toApplicationResponse(application, viewOptions(req, false)) : null);
    },

    async withdraw(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      await onboarding.withdraw(requireParam(req.params.id, 'Application'), auth.userId);
      sendNoContent(res);
    },

    // ---- moderation ----
    async list(req: Request, res: Response): Promise<void> {
      const page = await onboarding.list(req.query as Record<string, unknown>);
      sendCollection(
        res,
        page.items.map((application) => toApplicationResponse(application, viewOptions(req, true))),
        { next: page.nextCursor, hasMore: page.hasMore },
      );
    },

    async get(req: Request, res: Response): Promise<void> {
      const application = await onboarding.getForReview(requireParam(req.params.id, 'Application'));
      sendData(res, toApplicationResponse(application, viewOptions(req, true)));
    },

    /**
     * Decrypts and returns the applicant's identity numbers.
     *
     * Separate endpoint, separate permission, always audited. A moderator opens it
     * deliberately, alongside the passport scan, to compare the two.
     */
    async revealIdentity(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      if (!auth.permissions.has(Permission.ONBOARDING_REVEAL_IDENTITY)) {
        throw new AppError(ErrorCode.PERM_DENIED, {
          detail: 'Reading identity documents requires an additional permission',
        });
      }
      const revealed = await onboarding.revealIdentity(
        requireParam(req.params.id, 'Application'),
        auth.userId,
      );
      // A bearer-sensitive payload: never cached anywhere.
      res.setHeader('Cache-Control', 'private, no-store');
      sendData(res, revealed);
    },

    async claim(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const application = await onboarding.claim(requireParam(req.params.id, 'Application'), auth.userId);
      sendData(res, toApplicationResponse(application, viewOptions(req, true)));
    },

    async approve(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const application = await onboarding.approve(requireParam(req.params.id, 'Application'), auth.userId);
      sendData(res, toApplicationResponse(application, viewOptions(req, true)));
    },

    async reject(req: Request, res: Response): Promise<void> {
      const auth = requireAuth(req);
      const body = req.body as { reasonCode: never; reason: string };
      const application = await onboarding.reject(
        requireParam(req.params.id, 'Application'),
        auth.userId,
        body,
      );
      sendData(res, toApplicationResponse(application, viewOptions(req, true)));
    },
  };
}

export type OnboardingController = ReturnType<typeof createOnboardingController>;
