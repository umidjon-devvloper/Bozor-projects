import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '@bozorlar/errors';
import { sendCreated, sendData, sendNoContent } from '../../../http/envelope.js';
import { Permission } from '../../authz/index.js';
import type { MediaActor, MediaService } from '../services/media.service.js';
import type { MediaPurpose } from '../media.constants.js';

function actorOf(req: Request): MediaActor {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_REQUIRED);
  return { userId: req.auth.userId, permissions: req.auth.permissions };
}

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, { detail: `${name} not found` });
  return value;
}

export function createMediaController(media: MediaService) {
  return {
    async createUploadUrl(req: Request, res: Response): Promise<void> {
      const body = req.body as { purpose: MediaPurpose; contentType: string; sizeBytes: number };
      const ticket = await media.createUploadUrl({ ...body, actor: actorOf(req) });
      sendCreated(res, ticket);
    },

    async confirm(req: Request, res: Response): Promise<void> {
      const { mediaKey } = req.body as { mediaKey: string };
      sendData(res, await media.confirm(mediaKey, actorOf(req)));
    },

    async downloadUrl(req: Request, res: Response): Promise<void> {
      const actor = actorOf(req);
      const canReadPrivate = actor.permissions.has(Permission.MEDIA_READ_PRIVATE);
      const result = await media.createDownloadUrl(
        requireParam(req.params.mediaKey, 'Media asset'),
        actor,
        canReadPrivate,
      );
      // A signed URL is a bearer credential with a five-minute life; it must never be
      // cached by a proxy or a browser.
      res.setHeader('Cache-Control', 'private, no-store');
      sendData(res, result);
    },

    async remove(req: Request, res: Response): Promise<void> {
      await media.deleteUnattached(requireParam(req.params.mediaKey, 'Media asset'), actorOf(req));
      sendNoContent(res);
    },
  };
}

export type MediaController = ReturnType<typeof createMediaController>;
