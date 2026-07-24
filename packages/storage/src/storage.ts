import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@bozorlar/config';
import { AppError, ErrorCode } from '@bozorlar/errors';

/**
 * S3-compatible object storage (MinIO, in-country per ADR-0009).
 *
 * Lives in a shared package because two deployables need it: the API for the upload and
 * confirm path, and the worker for reclaiming orphaned objects. Duplicating the client setup
 * would let bucket naming drift between them and break reclamation silently (ADR-0011).
 *
 * The API never handles file bytes on upload: it issues a scoped presigned PUT and the client
 * writes directly to storage. It does read bytes back at confirm time, because everything the
 * client claimed about the object has to be verified against the object itself.
 */
/** Mirrors the media module's visibility enum without depending on it. */
export type StorageVisibility = 'PUBLIC' | 'PRIVATE';

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
}

export function createStorageService() {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });

  function bucketFor(visibility: StorageVisibility): string {
    return visibility === 'PUBLIC' ? env.S3_BUCKET_PUBLIC : env.S3_BUCKET_PRIVATE;
  }

  return {
    tempBucket: env.S3_BUCKET_TEMP,
    bucketFor,

    /**
     * Presigned PUT into the temp bucket.
     *
     * ContentLength is signed into the URL, so the client cannot upload more than it declared
     * — without that, a 10MB cap is advisory and a caller can write an arbitrarily large
     * object. The temp bucket has a one-day lifecycle rule, so an abandoned upload disappears
     * even if the confirm step never happens.
     */
    async createUploadUrl(input: {
      key: string;
      contentType: string;
      contentLength: number;
      expiresInSeconds: number;
    }): Promise<string> {
      const command = new PutObjectCommand({
        Bucket: env.S3_BUCKET_TEMP,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      });
      return getSignedUrl(client, command, { expiresIn: input.expiresInSeconds });
    },

    async createDownloadUrl(input: {
      bucket: string;
      key: string;
      filename: string;
      expiresInSeconds: number;
    }): Promise<string> {
      const command = new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        // Private documents are never rendered inline. A PDF opened in a browser tab is an
        // execution context; a download is not.
        ResponseContentDisposition: `attachment; filename="${input.filename}"`,
      });
      return getSignedUrl(client, command, { expiresIn: input.expiresInSeconds });
    },

    async head(bucket: string, key: string): Promise<ObjectHead> {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          contentLength: response.ContentLength ?? 0,
          contentType: response.ContentType,
          etag: response.ETag,
        };
      } catch (cause) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, {
          detail: 'No uploaded object was found for this media key',
          cause,
        });
      }
    },

    async getObject(bucket: string, key: string): Promise<Buffer> {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, { detail: 'Object body is empty' });
      }
      return Buffer.from(await response.Body.transformToByteArray());
    },

    /** Reads only the leading bytes, which is all the magic-byte check needs. */
    async getObjectHeader(bucket: string, key: string, bytes: number): Promise<Buffer> {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
      );
      if (!response.Body) {
        throw new AppError(ErrorCode.MEDIA_UPLOAD_NOT_CONFIRMED, { detail: 'Object body is empty' });
      }
      return Buffer.from(await response.Body.transformToByteArray());
    },

    async putObject(input: {
      bucket: string;
      key: string;
      body: Buffer;
      contentType: string;
      cacheControl?: string;
    }): Promise<void> {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ...(input.cacheControl !== undefined ? { CacheControl: input.cacheControl } : {}),
        }),
      );
    },

    async deleteObject(bucket: string, key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    publicUrl(key: string): string {
      return `${env.CDN_BASE_URL.replace(/\/$/, '')}/${key}`;
    },

    close(): void {
      client.destroy();
    },
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
