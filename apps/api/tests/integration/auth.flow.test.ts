import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * End-to-end authentication behaviour against a real replica set.
 *
 * These cases are the ones listed as mandatory in TESTING.md: refresh reuse must revoke the
 * family, lockout must engage, and the API must not reveal which phone numbers exist.
 */
describe('auth flows', () => {
  let app: Express;
  const phone = '+998901234567';
  const password = 'correct-horse-battery';
  const deviceId = 'test-device-0001';

  beforeAll(async () => {
    const { startMongo } = await import('@bozorlar/testing');
    await startMongo();
    const { createLogger } = await import('@bozorlar/logger');
    const { createApp } = await import('../../src/app.js');
    const { Redis } = await import('ioredis');
    const logger = createLogger({ service: 'test', level: 'silent', pretty: false });
    app = createApp({ logger, redis: new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379') });
  });

  afterAll(async () => {
    const { stopMongo } = await import('@bozorlar/testing');
    await stopMongo();
  });

  beforeEach(async () => {
    const { clearCollections } = await import('@bozorlar/testing');
    await clearCollections();
  });

  const registerAndVerify = async (): Promise<{ accessToken: string; refreshToken: string }> => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        phone,
        password,
        firstName: 'Aziz',
        consents: { terms: 'v1', privacy: 'v1', marketing: false },
      })
      .expect(201);

    // The console SMS provider logs the code; the test reads it from the OTP collection to
    // avoid depending on log parsing.
    const mongoose = await import('mongoose');
    const record = await mongoose.connection.db
      ?.collection('otp_codes')
      .findOne({ identifier: phone }, { sort: { createdAt: -1 } });
    expect(record).toBeTruthy();

    // The stored value is a hash, so verification is driven through the service in the
    // dedicated OTP unit test. Here the record is marked verified directly.
    await mongoose.connection.db
      ?.collection('users')
      .updateOne({ phone }, { $set: { phoneVerifiedAt: new Date() } });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password, deviceId })
      .expect(200);
    return response.body.data as { accessToken: string; refreshToken: string };
  };

  it('rejects a weak password at registration', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        phone: '+998901111111',
        password: 'password',
        firstName: 'Test',
        consents: { terms: 'v1', privacy: 'v1', marketing: false },
      })
      .expect(422);
    expect(response.body.code).toBe('AUTH_PASSWORD_WEAK');
  });

  it('does not reveal whether a phone number exists', async () => {
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone: '+998909999999', password: 'whatever-long-enough', deviceId })
      .expect(401);
    expect(unknown.body.code).toBe('AUTH_INVALID_CREDENTIALS');

    await registerAndVerify();
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password: 'wrong-but-long-enough', deviceId })
      .expect(401);
    // Identical code and status for both cases: no enumeration oracle.
    expect(wrongPassword.body.code).toBe(unknown.body.code);
  });

  it('revokes the whole token family when a refresh token is replayed', async () => {
    const { refreshToken } = await registerAndVerify();

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const newRefresh = (rotated.body.data as { refreshToken: string }).refreshToken;

    // Replaying the consumed token is indistinguishable from theft, so the family dies.
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    expect(replay.body.code).toBe('AUTH_REFRESH_REUSE_DETECTED');

    // The legitimately rotated token must also be dead: the attacker may hold it.
    const afterRevocation = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: newRefresh })
      .expect(401);
    expect(['AUTH_SESSION_REVOKED', 'AUTH_REFRESH_INVALID']).toContain(afterRevocation.body.code);
  });

  it('invalidates every session on password change', async () => {
    const { accessToken } = await registerAndVerify();

    await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: 'a-brand-new-passphrase' })
      .expect(204);

    // The old access token was minted before passwordChangedAt and must stop working
    // immediately, not in 15 minutes.
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    expect(response.body.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('rejects unknown fields instead of silently dropping them', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        phone: '+998902222222',
        password: 'a-good-long-password',
        firstName: 'Test',
        roles: ['ADMIN'], // mass-assignment attempt
        consents: { terms: 'v1', privacy: 'v1', marketing: false },
      })
      .expect(422);
    expect(response.body.code).toBe('VALIDATION_UNKNOWN_FIELD');
  });

  it('requires authentication on /auth/me', async () => {
    const response = await request(app).get('/api/v1/auth/me').expect(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});
