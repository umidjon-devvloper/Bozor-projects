import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Onboarding integration tests.
 *
 * Requires MinIO as well as MongoDB: KYC documents go through the real media pipeline, and
 * an application that cannot carry a passport scan is not the flow we are shipping.
 */
describe('seller onboarding', () => {
  let app: Express;
  let minio: StartedTestContainer;
  let marketId: string;
  let applicantToken: string;
  let moderatorToken: string;
  let supportToken: string;

  const APPLICANT_PHONE = '+998907770001';

  beforeAll(async () => {
    minio = await new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: 'bozorlar', MINIO_ROOT_PASSWORD: 'bozorlar-dev-secret' })
      .withExposedPorts(9000)
      .start();

    const endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
    Object.assign(process.env, {
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY: 'bozorlar',
      S3_SECRET_KEY: 'bozorlar-dev-secret',
      S3_FORCE_PATH_STYLE: 'true',
      S3_BUCKET_PUBLIC: 'bozorlar-public',
      S3_BUCKET_PRIVATE: 'bozorlar-private',
      S3_BUCKET_TEMP: 'bozorlar-temp',
      CDN_BASE_URL: `${endpoint}/bozorlar-public`,
      MEDIA_SCAN_ENABLED: 'false',
    });

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
    const { createLogger } = await import('@bozorlar/logger');
    const { seedGeography } = await import('../../src/seed/seedGeo.js');
    await seedGeography(createLogger({ service: 'seed', level: 'silent', pretty: false }));

    applicantToken = await createUser(APPLICANT_PHONE, ['BUYER']);
    moderatorToken = await createUser('+998907770002', ['MODERATOR', 'BUYER']);
    supportToken = await createUser('+998907770003', ['SUPPORT', 'BUYER']);
    const adminToken = await createUser('+998907770004', ['ADMIN', 'BUYER']);
    marketId = await createMarket(adminToken);
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

  async function createMarket(adminToken: string): Promise<string> {
    const district = await mongoose.connection.db?.collection('districts').findOne({ code: 'TSH-SHA' });
    const response = await request(app)
      .post('/api/v1/admin/markets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        districtId: String(district?._id),
        name: { uz: 'Chorsu bozori' },
        address: { uz: 'Chorsu maydoni 1' },
        location: { lat: 41.3262, lng: 69.2348 },
        workingHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday, opensAt: '06:00', closesAt: '19:00', isClosed: false,
        })),
      })
      .expect(201);
    return (response.body.data as { id: string }).id;
  }

  /** Uploads a KYC document through the real media pipeline and returns its key. */
  async function uploadDocument(token: string): Promise<string> {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(512, 0x20), Buffer.from('%%EOF')]);
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${token}`)
      .send({ purpose: 'KYC_DOCUMENT', contentType: 'application/pdf', sizeBytes: pdf.length })
      .expect(201);
    const { mediaKey, uploadUrl } = ticket.body.data as { mediaKey: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      body: pdf,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) },
    });
    await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ mediaKey })
      .expect(200);
    return mediaKey;
  }

  async function submitApplication(
    token = applicantToken,
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const [passport, contract] = await Promise.all([uploadDocument(token), uploadDocument(token)]);
    return request(app)
      .post('/api/v1/seller/applications')
      .set('Authorization', `Bearer ${token}`)
      .send({
        marketId,
        shopName: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        passportSeries: 'AA',
        passportNumber: '1234567',
        stir: '305678912',
        documents: [
          { type: 'PASSPORT', mediaKey: passport },
          { type: 'MARKET_CONTRACT', mediaKey: contract },
        ],
        ...overrides,
      });
  }

  it('completes the full approval journey and unlocks shop creation', async () => {
    // Before approval the applicant cannot open a shop.
    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(403);

    const submitted = await submitApplication();
    expect(submitted.status).toBe(201);
    const applicationId = (submitted.body.data as { id: string }).id;
    expect((submitted.body.data as { status: string }).status).toBe('SUBMITTED');

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/approve`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);

    // The role grant committed with the decision, so a fresh session can trade at once.
    const freshToken = await (async () => {
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: APPLICANT_PHONE, password: 'a-good-long-password', deviceId: 'after-approval' })
        .expect(200);
      return (login.body.data as { accessToken: string }).accessToken;
    })();

    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
  }, 120_000);

  it('never returns identity fields on any application response', async () => {
    const submitted = await submitApplication();
    const body = JSON.stringify(submitted.body);
    // The passport number was in the request; it must appear in no response, ever.
    expect(body).not.toContain('1234567');
    expect(body).not.toContain('305678912');
    expect(submitted.body.data).not.toHaveProperty('passportNumber');

    const mine = await request(app)
      .get('/api/v1/seller/applications/me')
      .set('Authorization', `Bearer ${applicantToken}`)
      .expect(200);
    expect(JSON.stringify(mine.body)).not.toContain('1234567');
  }, 120_000);

  it('stores identity data encrypted, never in plaintext', async () => {
    await submitApplication();
    const record = await mongoose.connection.db?.collection('seller_applications').findOne({});

    expect(record?.passportNumberEncrypted).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(JSON.stringify(record)).not.toContain('1234567');
    expect(JSON.stringify(record)).not.toContain('305678912');
    // Blind indexes are present so duplicates can be detected without decrypting.
    expect(record?.passportBlindIndex).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it('reveals identity only to a permitted moderator, and audits every read', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;

    const revealed = await request(app)
      .get(`/api/v1/admin/seller-applications/${applicationId}/identity`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);
    expect((revealed.body.data as { passportNumber: string }).passportNumber).toBe('1234567');
    expect(revealed.headers['cache-control']).toContain('no-store');

    const entry = await mongoose.connection.db
      ?.collection('audit_logs')
      .findOne({ action: 'onboarding.identity_revealed', targetId: applicationId });
    expect(entry?.severity).toBe('CRITICAL');
    // The audit trail records that it happened, masked — not the number itself.
    expect(JSON.stringify(entry)).not.toContain('1234567');
  }, 120_000);

  it('denies identity reveal to support and to the applicant', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;

    // Support handles the most social-engineering attempts and must never read a passport.
    await request(app)
      .get(`/api/v1/admin/seller-applications/${applicationId}/identity`)
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(403);

    await request(app)
      .get(`/api/v1/admin/seller-applications/${applicationId}/identity`)
      .set('Authorization', `Bearer ${applicantToken}`)
      .expect(403);
  }, 120_000);

  it('lets support read status but not decide', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;

    await request(app)
      .get(`/api/v1/admin/seller-applications/${applicationId}`)
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(200);

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/approve`)
      .set('Authorization', `Bearer ${supportToken}`)
      .expect(403);
  }, 120_000);

  it('requires a claim before a decision', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;

    const premature = await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/approve`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(409);
    expect(premature.body.code).toBe('RESOURCE_CONFLICT');
  }, 120_000);

  it('lets only one moderator claim an application', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;
    const second = await createUser('+998907770009', ['MODERATOR', 'BUYER']);

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${second}`)
      .expect(409);
  }, 120_000);

  it('requires a substantive reason to reject, and tells the applicant', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/reject`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reasonCode: 'DOCUMENT_UNREADABLE', reason: 'too short' })
      .expect(422);

    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/reject`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reasonCode: 'DOCUMENT_UNREADABLE', reason: 'The passport scan is blurred and unreadable' })
      .expect(200);

    const mine = await request(app)
      .get('/api/v1/seller/applications/me')
      .set('Authorization', `Bearer ${applicantToken}`)
      .expect(200);
    const body = mine.body.data as { status: string; rejectionReason: string; resubmissionsRemaining: number };
    expect(body.status).toBe('REJECTED');
    expect(body.rejectionReason).toContain('blurred');
    expect(body.resubmissionsRemaining).toBe(3);
  }, 120_000);

  it('refuses a second live application while one is in progress', async () => {
    await submitApplication();
    const duplicate = await submitApplication();
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');
  }, 120_000);

  it('refuses an identity already approved for another account', async () => {
    const first = await submitApplication();
    const applicationId = (first.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/approve`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);

    // A different person submitting the same passport must be stopped, without the system
    // ever decrypting a stored document to find out.
    const impostorToken = await createUser('+998907770005', ['BUYER']);
    const impostor = await submitApplication(impostorToken);
    expect(impostor.status).toBe(409);
    expect(String(impostor.body.detail)).toMatch(/already registered/i);

    const flagged = await mongoose.connection.db
      ?.collection('audit_logs')
      .findOne({ action: 'onboarding.duplicate_identity_attempt' });
    expect(flagged?.severity).toBe('CRITICAL');
  }, 120_000);

  it('rejects a submission missing a required document', async () => {
    const passport = await uploadDocument(applicantToken);
    const response = await request(app)
      .post('/api/v1/seller/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        marketId,
        shopName: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        passportSeries: 'AA',
        passportNumber: '1234567',
        stir: '305678912',
        documents: [{ type: 'PASSPORT', mediaKey: passport }],
      })
      .expect(422);
    expect(response.body.errors?.[0]?.code).toBe('MISSING_DOCUMENT');
  }, 120_000);

  it('refuses documents belonging to another user', async () => {
    const otherToken = await createUser('+998907770006', ['BUYER']);
    const stolenKey = await uploadDocument(otherToken);
    const ownKey = await uploadDocument(applicantToken);

    const response = await request(app)
      .post('/api/v1/seller/applications')
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        marketId,
        shopName: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        passportSeries: 'AA',
        passportNumber: '1234567',
        stir: '305678912',
        documents: [
          { type: 'PASSPORT', mediaKey: stolenKey },
          { type: 'MARKET_CONTRACT', mediaKey: ownKey },
        ],
      })
      .expect(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
  }, 120_000);

  it('attaches documents inside the submission transaction', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;
    const assets = await mongoose.connection.db
      ?.collection('media_assets')
      .find({ 'attachedTo.id': applicationId })
      .toArray();
    // Unattached KYC scans would be reclaimed by the orphan sweeper within the day.
    expect(assets).toHaveLength(2);
    expect(assets?.every((asset) => asset.status === 'ATTACHED')).toBe(true);
  }, 120_000);

  it('allows resubmission after rejection and counts attempts', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/claim`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .expect(200);
    await request(app)
      .post(`/api/v1/admin/seller-applications/${applicationId}/reject`)
      .set('Authorization', `Bearer ${moderatorToken}`)
      .send({ reasonCode: 'DOCUMENT_UNREADABLE', reason: 'The passport scan is blurred and unreadable' })
      .expect(200);

    const [passport, contract] = await Promise.all([
      uploadDocument(applicantToken),
      uploadDocument(applicantToken),
    ]);
    const resubmitted = await request(app)
      .patch(`/api/v1/seller/applications/${applicationId}`)
      .set('Authorization', `Bearer ${applicantToken}`)
      .send({
        marketId,
        shopName: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        passportSeries: 'AA',
        passportNumber: '1234567',
        stir: '305678912',
        documents: [
          { type: 'PASSPORT', mediaKey: passport },
          { type: 'MARKET_CONTRACT', mediaKey: contract },
        ],
      })
      .expect(200);

    const body = resubmitted.body.data as { status: string; resubmissionCount: number };
    expect(body.status).toBe('SUBMITTED');
    expect(body.resubmissionCount).toBe(1);
  }, 120_000);

  it('lets an applicant withdraw and releases their documents', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;

    await request(app)
      .post(`/api/v1/seller/applications/${applicationId}/withdraw`)
      .set('Authorization', `Bearer ${applicantToken}`)
      .expect(204);

    const assets = await mongoose.connection.db
      ?.collection('media_assets')
      .find({ purpose: 'KYC_DOCUMENT' })
      .toArray();
    expect(assets?.every((asset) => asset.status === 'CONFIRMED')).toBe(true);

    // Withdrawal frees the slot, so a fresh application is possible.
    expect((await submitApplication()).status).toBe(201);
  }, 120_000);

  it('reports another applicant\'s application as missing rather than forbidden', async () => {
    const submitted = await submitApplication();
    const applicationId = (submitted.body.data as { id: string }).id;
    const outsider = await createUser('+998907770007', ['BUYER']);

    await request(app)
      .post(`/api/v1/seller/applications/${applicationId}/withdraw`)
      .set('Authorization', `Bearer ${outsider}`)
      .expect(404);
  }, 120_000);

  it('rejects an unknown market', async () => {
    const response = await submitApplication(applicantToken, {
      marketId: '665f1a2b3c4d5e6f7a8b9c0d',
    });
    expect(response.status).toBe(404);
  }, 120_000);

  it('writes a domain event inside the submission transaction', async () => {
    await submitApplication();
    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'seller.applied' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events?.[0]?.publishedAt).toBeNull();
  }, 120_000);
});
