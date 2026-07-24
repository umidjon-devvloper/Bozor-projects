import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Media integration tests against real MinIO and a real replica set.
 *
 * Storage behaviour cannot be meaningfully faked: presigned URL signing, the ContentLength
 * binding, range reads and bucket promotion are all properties of the storage layer itself.
 */
describe('media module', () => {
  let app: Express;
  let minio: StartedTestContainer;
  let token: string;
  let moderatorToken: string;

  beforeAll(async () => {
    minio = await new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: 'bozorlar', MINIO_ROOT_PASSWORD: 'bozorlar-dev-secret' })
      .withExposedPorts(9000)
      .start();

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_ACCESS_KEY = 'bozorlar';
    process.env.S3_SECRET_KEY = 'bozorlar-dev-secret';
    process.env.S3_FORCE_PATH_STYLE = 'true';
    process.env.S3_BUCKET_PUBLIC = 'bozorlar-public';
    process.env.S3_BUCKET_PRIVATE = 'bozorlar-private';
    process.env.S3_BUCKET_TEMP = 'bozorlar-temp';
    process.env.CDN_BASE_URL = `${endpoint}/bozorlar-public`;
    process.env.MEDIA_SCAN_ENABLED = 'false';

    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'bozorlar', secretAccessKey: 'bozorlar-dev-secret' },
    });
    for (const bucket of ['bozorlar-public', 'bozorlar-private', 'bozorlar-temp']) {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }

    const { startMongo } = await import('@bozorlar/testing');
    await startMongo();
    const { createLogger } = await import('@bozorlar/logger');
    const { createApp } = await import('../../src/app.js');
    const { Redis } = await import('ioredis');
    app = createApp({
      logger: createLogger({ service: 'test', level: 'silent', pretty: false }),
      redis: new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
  }, 180_000);

  afterAll(async () => {
    const { stopMongo } = await import('@bozorlar/testing');
    await stopMongo();
    await minio.stop();
  });

  beforeEach(async () => {
    const { clearCollections } = await import('@bozorlar/testing');
    await clearCollections();
    token = await createUser('+998905550001', ['BUYER']);
    moderatorToken = await createUser('+998905550002', ['MODERATOR', 'BUYER']);
  });

  async function createUser(phone: string, roles: string[]): Promise<string> {
    const password = 'a-good-long-password';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ phone, password, firstName: 'Test', consents: { terms: 'v1', privacy: 'v1', marketing: false } })
      .expect(201);
    await mongoose.connection.db
      ?.collection('users')
      .updateOne({ phone }, { $set: { phoneVerifiedAt: new Date(), roles } });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password, deviceId: `device-${phone}` })
      .expect(200);
    return (login.body.data as { accessToken: string }).accessToken;
  }

  const makeJpeg = async (width = 800, height = 600): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } } })
      .jpeg()
      .toBuffer();

  async function uploadAndConfirm(
    authToken: string,
    purpose: string,
    body: Buffer,
    contentType = 'image/jpeg',
  ): Promise<{ mediaKey: string; confirm: request.Response }> {
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ purpose, contentType, sizeBytes: body.length })
      .expect(201);

    const { mediaKey, uploadUrl } = ticket.body.data as { mediaKey: string; uploadUrl: string };

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
    });
    expect(put.ok).toBe(true);

    const confirm = await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ mediaKey });

    return { mediaKey, confirm };
  }

  it('completes the full upload lifecycle and generates derivatives', async () => {
    const jpeg = await makeJpeg();
    const { mediaKey, confirm } = await uploadAndConfirm(token, 'PRODUCT_IMAGE', jpeg);
    expect(confirm.status).toBe(200);

    const asset = confirm.body.data as {
      url: string;
      width: number;
      height: number;
      blurhash: string;
      variants: Array<{ name: string; url: string }>;
    };
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
    expect(asset.blurhash).toMatch(/^[\w#$%*+,\-.:;=?@[\]^_{|}~]+$/);
    expect(asset.variants.map((v) => v.name).sort()).toEqual(['card', 'full', 'thumb']);

    // The derivatives are real objects in the public bucket, not just database rows.
    for (const variant of asset.variants) {
      const response = await fetch(variant.url);
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toBe('image/webp');
    }

    const record = await mongoose.connection.db
      ?.collection('media_assets')
      .findOne({ mediaKey });
    expect(record?.status).toBe('CONFIRMED');
    expect(record?.bucket).toBe('bozorlar-public');
  }, 60_000);

  it('strips EXIF GPS from an uploaded photo', async () => {
    // A product photo taken at a stall carries the seller's coordinates. Publishing that is
    // the failure this pipeline exists to prevent (SECURITY.md).
    const withGps = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 120, b: 90 } },
    })
      .withExif({
        IFD0: { Copyright: 'Bozorlar' },
        // sharp writes any EXIF IFD at runtime; its published `Exif` type lists only
        // IFD0-3, so the GPS block needs a cast. Type-only change (repository recovery).
        GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      } as Parameters<sharp.Sharp['withExif']>[0])
      .jpeg()
      .toBuffer();

    const before = await sharp(withGps).metadata();
    expect(before.exif).toBeDefined();

    const { confirm } = await uploadAndConfirm(token, 'PRODUCT_IMAGE', withGps);
    expect(confirm.status).toBe(200);

    const variantUrl = (confirm.body.data as { variants: Array<{ url: string }> }).variants[0]!.url;
    const downloaded = Buffer.from(await (await fetch(variantUrl)).arrayBuffer());
    const after = await sharp(downloaded).metadata();
    expect(after.exif).toBeUndefined();
  }, 60_000);

  it('rejects a file whose bytes contradict its declared type', async () => {
    const disguised = Buffer.from('%PDF-1.7\n%fake pdf pretending to be a jpeg');
    const { confirm } = await uploadAndConfirm(token, 'PRODUCT_IMAGE', disguised);
    expect(confirm.status).toBe(422);
    expect(confirm.body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');

    const record = await mongoose.connection.db
      ?.collection('media_assets')
      .findOne({ mediaKey: (confirm.request as unknown as { _data: { mediaKey: string } })._data.mediaKey });
    expect(record?.status).toBe('REJECTED');
  }, 60_000);

  it('rejects the EICAR test file', async () => {
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'KYC_DOCUMENT', contentType: 'application/pdf', sizeBytes: eicar.length })
      .expect(201);
    const { mediaKey, uploadUrl } = ticket.body.data as { mediaKey: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      body: eicar,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(eicar.length) },
    });

    const confirm = await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ mediaKey });
    // Detected as not-a-PDF before it even reaches the scanner; either rejection is correct.
    expect([422]).toContain(confirm.status);
    expect(['MEDIA_TYPE_NOT_ALLOWED', 'MEDIA_VIRUS_DETECTED']).toContain(confirm.body.code);
  }, 60_000);

  it('refuses a purpose that does not accept the content type', async () => {
    const response = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'application/pdf', sizeBytes: 1000 })
      .expect(422);
    expect(response.body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
  });

  it('refuses a declared size above the purpose cap', async () => {
    const response = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: 10 * 1024 * 1024 })
      .expect(413);
    expect(response.body.code).toBe('MEDIA_TOO_LARGE');
  });

  it('binds the size into the presigned URL so the cap is enforced by storage', async () => {
    const declared = 1024;
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/jpeg', sizeBytes: declared })
      .expect(201);
    const { uploadUrl } = ticket.body.data as { uploadUrl: string };

    // Uploading more than was declared must fail at the storage layer, not merely be
    // caught later by the API.
    const oversized = await makeJpeg(2000, 2000);
    expect(oversized.length).toBeGreaterThan(declared);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: oversized,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(oversized.length) },
    });
    expect(put.ok).toBe(false);
  }, 60_000);

  it('will not confirm an object that was never uploaded', async () => {
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/jpeg', sizeBytes: 1024 })
      .expect(201);
    const { mediaKey } = ticket.body.data as { mediaKey: string };

    const confirm = await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ mediaKey })
      .expect(409);
    expect(confirm.body.code).toBe('MEDIA_UPLOAD_NOT_CONFIRMED');
  });

  it('is idempotent under a duplicate confirm', async () => {
    const jpeg = await makeJpeg(200, 200);
    const { mediaKey, confirm } = await uploadAndConfirm(token, 'AVATAR', jpeg);
    expect(confirm.status).toBe(200);

    const again = await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ mediaKey })
      .expect(409);
    expect(again.body.code).toBe('RESOURCE_CONFLICT');
  }, 60_000);

  it('reports another user\'s asset as missing rather than forbidden', async () => {
    const jpeg = await makeJpeg(200, 200);
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: jpeg.length })
      .expect(201);
    const { mediaKey, uploadUrl } = ticket.body.data as { mediaKey: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      body: jpeg,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpeg.length) },
    });

    const intruder = await createUser('+998905550003', ['BUYER']);
    const confirm = await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${intruder}`)
      .send({ mediaKey })
      .expect(404);
    expect(confirm.body.code).toBe('RESOURCE_NOT_FOUND');
  }, 60_000);

  it('keeps KYC documents out of the public bucket and behind signed URLs', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20), Buffer.from('%%EOF')]);
    const { mediaKey, confirm } = await uploadAndConfirm(token, 'KYC_DOCUMENT', pdf, 'application/pdf');
    expect(confirm.status).toBe(200);
    // No public URL is ever emitted for a private asset.
    expect((confirm.body.data as { url: string | null }).url).toBeNull();

    const record = await mongoose.connection.db?.collection('media_assets').findOne({ mediaKey });
    expect(record?.bucket).toBe('bozorlar-private');

    const download = await request(app)
      .get(`/api/v1/media/${mediaKey}/download-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const { url } = download.body.data as { url: string };

    const fetched = await fetch(url);
    expect(fetched.ok).toBe(true);
    // Served as an attachment: a PDF rendered inline is an execution context.
    expect(fetched.headers.get('content-disposition')).toContain('attachment');
  }, 60_000);

  it('audits every moderator access to a private document', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 0x20)]);
    const { mediaKey } = await uploadAndConfirm(token, 'KYC_DOCUMENT', pdf, 'application/pdf');

    await request(app)
      .get(`/api/v1/media/${mediaKey}/download-url`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);

    const entry = await mongoose.connection.db
      ?.collection('audit_logs')
      .findOne({ action: 'media.private_access', targetId: mediaKey });
    expect(entry).toBeTruthy();
    expect(entry?.severity).toBe('WARNING');
  }, 60_000);

  it('denies a private document to a user with no claim to it', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 0x20)]);
    const { mediaKey } = await uploadAndConfirm(token, 'KYC_DOCUMENT', pdf, 'application/pdf');

    const outsider = await createUser('+998905550004', ['BUYER']);
    await request(app)
      .get(`/api/v1/media/${mediaKey}/download-url`)
      .set('Authorization', `Bearer ${outsider}`)
      .expect(404);
  }, 60_000);

  it('enforces the daily quota per purpose', async () => {
    // AVATAR has the tightest quota, which keeps this test fast.
    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post('/api/v1/media/upload-url')
        .set('Authorization', `Bearer ${token}`)
        .send({ purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: 1024 })
        .expect(201);
    }
    const blocked = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: 1024 })
      .expect(429);
    expect(blocked.body.code).toBe('MEDIA_QUOTA_EXCEEDED');
  }, 60_000);

  it('deletes an unattached asset and its derivatives', async () => {
    const jpeg = await makeJpeg(300, 300);
    const { mediaKey, confirm } = await uploadAndConfirm(token, 'PRODUCT_IMAGE', jpeg);
    const variantUrl = (confirm.body.data as { variants: Array<{ url: string }> }).variants[0]!.url;
    expect((await fetch(variantUrl)).ok).toBe(true);

    await request(app)
      .delete(`/api/v1/media/${mediaKey}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect((await fetch(variantUrl)).ok).toBe(false);
    const record = await mongoose.connection.db?.collection('media_assets').findOne({ mediaKey });
    expect(record).toBeNull();
  }, 60_000);

  it('requires authentication for every media endpoint', async () => {
    await request(app).post('/api/v1/media/upload-url').send({}).expect(401);
    await request(app).post('/api/v1/media/confirm').send({}).expect(401);
  });
});
