import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { AppError, ErrorCode, notFound } from '@bozorlar/errors';
import type { Logger } from '@bozorlar/logger';
import { ActorType, AuditSeverity } from '@bozorlar/types';
import type { AuditService } from '../../audit/index.js';
import type {
  MediaPurpose} from '../media.constants.js';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  MediaVisibility,
  PURPOSE_POLICIES,
  UNATTACHED_TTL_HOURS,
  UPLOAD_URL_TTL_SECONDS,
} from '../media.constants.js';
import { MediaStatus } from '../models/mediaAsset.model.js';
import {
  mediaAssetRepository,
  type MediaAssetRecord,
} from '../repositories/mediaAsset.repository.js';
import { assertContentTypeAllowed, extensionFor, MAGIC_BYTE_WINDOW } from './fileType.service.js';
import { assertClean, type VirusScanner } from './virusScanner.service.js';
import { processImage, stripMetadata } from './imageProcessor.service.js';
import type { StorageService } from '@bozorlar/storage';

export interface UploadTicket {
  mediaKey: string;
  uploadUrl: string;
  expiresAt: string;
  maxSizeBytes: number;
  requiredContentType: string;
  requiredContentLength: number;
}

export interface ConfirmedAsset {
  mediaKey: string;
  url: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  sizeBytes: number;
  variants: Array<{ name: string; url: string; width: number; height: number }>;
}

export interface MediaActor {
  userId: string;
  permissions: ReadonlySet<string>;
}

export function createMediaService(deps: {
  storage: StorageService;
  scanner: VirusScanner;
  audit: AuditService;
  logger: Logger;
}) {
  const { storage, scanner, audit, logger } = deps;

  /**
   * Object keys are generated, never derived from anything the client sends.
   *
   * A user-supplied filename in a storage key permits traversal (`../`), collision with
   * another user's object, and enumeration. The date prefix keeps listings navigable for
   * operators without making keys guessable.
   */
  function generateKey(purpose: MediaPurpose, ownerId: string, extension: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const random = randomBytes(16).toString('hex');
    return `${purpose.toLowerCase()}/${date}/${ownerId}/${random}.${extension}`;
  }

  function variantKey(baseKey: string, variantName: string): string {
    const withoutExtension = baseKey.replace(/\.[^./]+$/, '');
    return `${withoutExtension}_${variantName}.webp`;
  }

  return {
    /**
     * Issues a scoped, expiring presigned PUT.
     *
     * Size is validated here *and* signed into the URL, so the cap is enforced by storage
     * rather than by trust. Nothing is written to the final bucket at this point: the object
     * lands in a temp bucket with a one-day lifecycle rule.
     */
    async createUploadUrl(input: {
      purpose: MediaPurpose;
      contentType: string;
      sizeBytes: number;
      actor: MediaActor;
    }): Promise<UploadTicket> {
      const policy = PURPOSE_POLICIES[input.purpose];

      if (!policy.allowedMimeTypes.includes(input.contentType)) {
        throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
          detail: `${input.contentType} is not accepted for ${input.purpose}`,
          params: { allowed: policy.allowedMimeTypes },
        });
      }
      if (input.sizeBytes <= 0 || input.sizeBytes > policy.maxSizeBytes) {
        throw new AppError(ErrorCode.MEDIA_TOO_LARGE, {
          detail: `Files for ${input.purpose} must be between 1 byte and ${policy.maxSizeBytes} bytes`,
          params: { maxSizeBytes: policy.maxSizeBytes, received: input.sizeBytes },
        });
      }

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const used = await mediaAssetRepository.countRecent(input.actor.userId, input.purpose, since);
      if (used >= policy.dailyQuota) {
        throw new AppError(ErrorCode.MEDIA_QUOTA_EXCEEDED, {
          detail: `Daily upload limit for ${input.purpose} reached`,
          params: { quota: policy.dailyQuota, used },
        });
      }

      const extension = extensionFor(input.contentType as never);
      const mediaKey = generateKey(input.purpose, input.actor.userId, extension);
      const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);

      const uploadUrl = await storage.createUploadUrl({
        key: mediaKey,
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });

      await mediaAssetRepository.create({
        mediaKey,
        ownerId: input.actor.userId,
        purpose: input.purpose,
        visibility: policy.visibility,
        bucket: storage.tempBucket,
        declaredContentType: input.contentType,
        sizeBytes: input.sizeBytes,
        expiresAt,
      });

      return {
        mediaKey,
        uploadUrl,
        expiresAt: expiresAt.toISOString(),
        maxSizeBytes: policy.maxSizeBytes,
        requiredContentType: input.contentType,
        requiredContentLength: input.sizeBytes,
      };
    },

    /**
     * Verifies, scans, processes and promotes an uploaded object.
     *
     * Everything the client asserted at ticket time is re-checked against the object itself:
     * that it exists, its real size, and its real type from magic bytes. Only then is it
     * scanned, re-encoded to strip metadata, and written to its final bucket.
     */
    async confirm(mediaKey: string, actor: MediaActor): Promise<ConfirmedAsset> {
      const asset = await mediaAssetRepository.findByKey(mediaKey);
      if (!asset) throw notFound('Media asset');
      if (asset.ownerId !== actor.userId) {
        throw notFound('Media asset', `PERM_SCOPE_DENIED user=${actor.userId} key=${mediaKey}`);
      }
      if (asset.status !== MediaStatus.PENDING) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: `This upload is already ${asset.status.toLowerCase()}`,
        });
      }

      const policy = PURPOSE_POLICIES[asset.purpose];
      const head = await storage.head(storage.tempBucket, mediaKey);

      if (head.contentLength > policy.maxSizeBytes) {
        await this.rejectAsset(mediaKey, 'Uploaded object exceeds the size limit', null);
        throw new AppError(ErrorCode.MEDIA_TOO_LARGE, {
          detail: 'The uploaded object is larger than permitted',
          params: { maxSizeBytes: policy.maxSizeBytes, actual: head.contentLength },
        });
      }

      const header = await storage.getObjectHeader(storage.tempBucket, mediaKey, MAGIC_BYTE_WINDOW);
      let detected: string;
      try {
        detected = assertContentTypeAllowed({
          header,
          declaredContentType: asset.declaredContentType,
          allowedMimeTypes: policy.allowedMimeTypes,
        });
      } catch (error) {
        await this.rejectAsset(mediaKey, 'Content type verification failed', null);
        throw error;
      }

      const body = await storage.getObject(storage.tempBucket, mediaKey);

      try {
        await assertClean(scanner, body, logger);
      } catch (error) {
        if (AppError.isAppError(error) && error.code === ErrorCode.MEDIA_VIRUS_DETECTED) {
          await this.rejectAsset(
            mediaKey,
            'Rejected by malware scanner',
            String(error.params?.signature ?? 'unknown'),
          );
          await audit.record({
            actorId: actor.userId,
            actorType: ActorType.USER,
            action: 'media.virus_detected',
            targetType: 'media',
            targetId: mediaKey,
            after: { signature: error.params?.signature ?? null },
            severity: AuditSeverity.CRITICAL,
          });
        }
        throw error;
      }

      const targetBucket = storage.bucketFor(asset.visibility);
      const checksum = createHash('sha256').update(body).digest('hex');

      let width: number | null = null;
      let height: number | null = null;
      let blurhash: string | null = null;
      const storedVariants: Array<{ name: string; key: string; width: number; height: number; sizeBytes: number; contentType: string }> = [];
      let finalBody = body;
      let finalContentType = detected;
      let finalSize = body.length;

      const isImage = detected.startsWith('image/');

      if (isImage && policy.variants.length > 0) {
        const processed = await processImage(body, policy.variants);
        width = processed.original.width;
        height = processed.original.height;
        blurhash = processed.blurhash;

        for (const variant of processed.variants) {
          const key = variantKey(mediaKey, variant.name);
          await storage.putObject({
            bucket: targetBucket,
            key,
            body: variant.data,
            contentType: variant.contentType,
            // Keys are content-addressed by randomness and never rewritten, so derivatives
            // are safe to cache for a year.
            cacheControl: 'public, max-age=31536000, immutable',
          });
          storedVariants.push({
            name: variant.name,
            key,
            width: variant.width,
            height: variant.height,
            sizeBytes: variant.sizeBytes,
            contentType: variant.contentType,
          });
        }
      } else if (isImage && policy.reencode) {
        finalBody = await stripMetadata(body);
        finalContentType = 'image/webp';
        finalSize = finalBody.length;
      }

      await storage.putObject({
        bucket: targetBucket,
        key: mediaKey,
        body: finalBody,
        contentType: finalContentType,
        ...(asset.visibility === MediaVisibility.PUBLIC
          ? { cacheControl: 'public, max-age=31536000, immutable' }
          : { cacheControl: 'private, no-store' }),
      });

      const confirmed = await mediaAssetRepository.confirm(mediaKey, {
        bucket: targetBucket,
        detectedContentType: finalContentType,
        sizeBytes: finalSize,
        width,
        height,
        blurhash,
        checksum,
        variants: storedVariants,
        // Confirmed but unattached assets are swept after this window.
        expiresAt: new Date(Date.now() + UNATTACHED_TTL_HOURS * 60 * 60 * 1000),
      });

      if (!confirmed) {
        // Lost a race with a concurrent confirm. The other call did the work; the temp
        // object is removed below either way, so this is safe to report as a conflict.
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, { detail: 'This upload was already confirmed' });
      }

      // Best-effort: the temp bucket has a lifecycle rule, so a failure here costs a day of
      // storage rather than correctness.
      try {
        await storage.deleteObject(storage.tempBucket, mediaKey);
      } catch (cause) {
        logger.warn({ err: cause, mediaKey }, 'failed to remove temp object; lifecycle will reclaim it');
      }

      logger.info({ mediaKey, purpose: asset.purpose, sizeBytes: finalSize }, 'media confirmed');
      return this.toPublicView(confirmed);
    },

    async rejectAsset(mediaKey: string, reason: string, signature: string | null): Promise<void> {
      await mediaAssetRepository.reject(mediaKey, reason, signature);
      try {
        await storage.deleteObject(storage.tempBucket, mediaKey);
      } catch (cause) {
        logger.warn({ err: cause, mediaKey }, 'failed to remove rejected temp object');
      }
    },

    toPublicView(asset: MediaAssetRecord): ConfirmedAsset {
      const isPublic = asset.visibility === MediaVisibility.PUBLIC;
      return {
        mediaKey: asset.mediaKey,
        url: isPublic ? storage.publicUrl(asset.mediaKey) : null,
        width: asset.width,
        height: asset.height,
        blurhash: asset.blurhash,
        sizeBytes: asset.sizeBytes,
        variants: asset.variants.map((variant) => ({
          name: variant.name,
          url: isPublic ? storage.publicUrl(variant.key) : '',
          width: variant.width,
          height: variant.height,
        })),
      };
    },

    /**
     * Short-lived signed URL for a private object.
     *
     * Every issue is audited, because these objects are passport scans and dispute evidence:
     * "who looked at this document, and when" is a question that will be asked
     * (COMPLIANCE.md).
     */
    async createDownloadUrl(
      mediaKey: string,
      actor: MediaActor,
      canReadPrivate: boolean,
    ): Promise<{ url: string; expiresAt: string }> {
      const asset = await mediaAssetRepository.findByKey(mediaKey);
      if (!asset) throw notFound('Media asset');

      const isOwner = asset.ownerId === actor.userId;
      if (!isOwner && !canReadPrivate) {
        throw notFound('Media asset', `PERM_SCOPE_DENIED user=${actor.userId} key=${mediaKey}`);
      }
      if (asset.status === MediaStatus.PENDING || asset.status === MediaStatus.REJECTED) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
          detail: 'This asset is not available',
        });
      }

      const filename = `${asset.purpose.toLowerCase()}-${asset.mediaKey.split('/').pop() ?? 'file'}`;
      const url = await storage.createDownloadUrl({
        bucket: asset.bucket,
        key: asset.mediaKey,
        filename,
        expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      });

      if (asset.visibility === MediaVisibility.PRIVATE) {
        await audit.record({
          actorId: actor.userId,
          actorType: isOwner ? ActorType.USER : ActorType.ADMIN,
          action: 'media.private_access',
          targetType: 'media',
          targetId: mediaKey,
          after: { purpose: asset.purpose, ownerId: asset.ownerId },
          severity: AuditSeverity.WARNING,
        });
      }

      return {
        url,
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },

    async deleteUnattached(mediaKey: string, actor: MediaActor): Promise<void> {
      const asset = await mediaAssetRepository.findByKey(mediaKey);
      if (!asset) throw notFound('Media asset');
      if (asset.ownerId !== actor.userId) {
        throw notFound('Media asset', `PERM_SCOPE_DENIED user=${actor.userId} key=${mediaKey}`);
      }
      if (asset.status === MediaStatus.ATTACHED) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, {
          detail: 'This file is in use; remove it from the item that references it first',
        });
      }

      for (const variant of asset.variants) {
        await storage.deleteObject(asset.bucket, variant.key).catch(() => undefined);
      }
      await storage.deleteObject(asset.bucket, asset.mediaKey).catch(() => undefined);
      await storage.deleteObject(storage.tempBucket, asset.mediaKey).catch(() => undefined);
      await mediaAssetRepository.delete(mediaKey);
    },

    /**
     * Validates and attaches media keys to an owning entity.
     *
     * Other modules call this inside their own transaction. It verifies ownership, purpose
     * and status before attaching, so a caller cannot bind someone else's file — or an
     * unscanned one — to their product.
     */
    async attachToEntity(input: {
      mediaKeys: readonly string[];
      target: { type: string; id: string };
      expectedPurpose: MediaPurpose;
      ownerId: string;
      session: ClientSession;
    }): Promise<void> {
      if (input.mediaKeys.length === 0) return;

      const assets = await mediaAssetRepository.findManyByKeys(input.mediaKeys);
      const found = new Set(assets.map((asset) => asset.mediaKey));
      const missing = input.mediaKeys.filter((key) => !found.has(key));
      if (missing.length > 0) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
          detail: 'One or more files were not found',
          params: { missing },
        });
      }

      for (const asset of assets) {
        if (asset.ownerId !== input.ownerId) {
          throw notFound('Media asset', `PERM_SCOPE_DENIED key=${asset.mediaKey}`);
        }
        if (asset.purpose !== input.expectedPurpose) {
          throw new AppError(ErrorCode.MEDIA_TYPE_NOT_ALLOWED, {
            detail: `File ${asset.mediaKey} was uploaded for ${asset.purpose}, not ${input.expectedPurpose}`,
          });
        }
        if (asset.status !== MediaStatus.CONFIRMED) {
          throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
            detail: `File ${asset.mediaKey} has not been confirmed`,
          });
        }
      }

      await mediaAssetRepository.attach(input.mediaKeys, input.target, input.session);
    },

    async detachFromEntity(
      target: { type: string; id: string },
      session: ClientSession,
    ): Promise<number> {
      return mediaAssetRepository.detachAllFor(target, session);
    },

    async resolveMany(mediaKeys: readonly string[]): Promise<Map<string, ConfirmedAsset>> {
      const assets = await mediaAssetRepository.findManyByKeys(mediaKeys);
      return new Map(assets.map((asset) => [asset.mediaKey, this.toPublicView(asset)]));
    },
  };
}

export type MediaService = ReturnType<typeof createMediaService>;
