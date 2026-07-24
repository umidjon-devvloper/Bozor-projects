import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';

/**
 * Geo module integration tests against a real replica set.
 *
 * These cover the behaviours that only appear when the database is real: the transactional
 * shop-creation path, the visibility cascade when a market closes, and the geo index.
 */
describe('geo module', () => {
  let app: Express;
  let regionId: string;
  let districtId: string;
  let adminToken: string;
  let sellerToken: string;
  let sellerPhone = '+998901110000';

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

    const { createLogger } = await import('@bozorlar/logger');
    const { seedGeography } = await import('../../src/seed/seedGeo.js');
    await seedGeography(createLogger({ service: 'seed', level: 'silent', pretty: false }));

    const region = await mongoose.connection.db?.collection('regions').findOne({ code: 'TSH' });
    const district = await mongoose.connection.db
      ?.collection('districts')
      .findOne({ code: 'TSH-SHA' });
    regionId = String(region?._id);
    districtId = String(district?._id);

    adminToken = await createUser('+998900000001', ['ADMIN', 'BUYER']);
    sellerPhone = '+998901110000';
    sellerToken = await createUser(sellerPhone, ['SELLER_OWNER', 'BUYER']);
  });

  /** Creates a verified user directly and signs in, so tests exercise geo, not auth. */
  async function createUser(phone: string, roles: string[]): Promise<string> {
    const password = 'a-good-long-password';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ phone, password, firstName: 'Test', consents: { terms: 'v1', privacy: 'v1', marketing: false } })
      .expect(201);
    await mongoose.connection.db
      ?.collection('users')
      .updateOne(
        { phone },
        { $set: { phoneVerifiedAt: new Date(), roles, twoFactorEnabled: false } },
      );
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password, deviceId: `device-${phone}` })
      .expect(200);
    return (login.body.data as { accessToken: string }).accessToken;
  }

  async function createMarket(): Promise<string> {
    const response = await request(app)
      .post('/api/v1/admin/markets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        districtId,
        name: { uz: 'Chorsu bozori', ru: 'Чорсу базар' },
        address: { uz: 'Chorsu maydoni 1' },
        location: { lat: 41.3262, lng: 69.2348 },
        workingHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday, opensAt: '06:00', closesAt: '19:00', isClosed: false,
        })),
        sections: [{ code: 'B', name: { uz: 'Sabzavot qatori' } }],
      })
      .expect(201);
    return (response.body.data as { id: string }).id;
  }

  it('seeds the full administrative division of Uzbekistan', async () => {
    const regions = await request(app).get('/api/v1/geo/regions').expect(200);
    expect(regions.body.data).toHaveLength(14);

    const districts = await request(app)
      .get(`/api/v1/geo/regions/${regionId}/districts`)
      .expect(200);
    expect(districts.body.data).toHaveLength(12);
    expect(districts.body.data[0].name).toBeTypeOf('string');
  });

  it('resolves localized names against Accept-Language', async () => {
    const ru = await request(app)
      .get('/api/v1/geo/regions')
      .set('Accept-Language', 'ru')
      .expect(200);
    const names = (ru.body.data as Array<{ code: string; name: string }>);
    expect(names.find((r) => r.code === 'TSH')?.name).toBe('город Ташкент');
  });

  it('finds markets by proximity and orders them by distance', async () => {
    await createMarket();
    const response = await request(app)
      .get('/api/v1/markets/nearby')
      .query({ lat: 41.3111, lng: 69.2797, radius: 10000 })
      .expect(200);
    const markets = response.body.data as Array<{ distanceMeters: number; isOpenNow: boolean }>;
    expect(markets).toHaveLength(1);
    expect(markets[0]!.distanceMeters).toBeGreaterThan(0);
    expect(markets[0]!.distanceMeters).toBeLessThan(10000);
    expect(typeof markets[0]!.isOpenNow).toBe('boolean');
  });

  it('rejects an out-of-range radius rather than scanning the collection', async () => {
    await request(app)
      .get('/api/v1/markets/nearby')
      .query({ lat: 41.3, lng: 69.2, radius: 999999 })
      .expect(422);
  });

  it('creates a shop, grants the owner access, and keeps it hidden until moderated', async () => {
    const marketId = await createMarket();

    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        marketId,
        name: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        sectionCode: 'B',
        stallNo: '42',
      })
      .expect(201);

    const shop = created.body.data as { id: string; slug: string; isVisible: boolean };
    expect(shop.slug).toBe('aziz-sabzavot');
    // A new shop is not published until a moderator approves it.
    expect(shop.isVisible).toBe(false);

    // Public lookup must report it as missing, not as forbidden (ADR-0029).
    await request(app).get(`/api/v1/shops/${shop.id}`).expect(404);

    // users.shopIds was updated in the same transaction, so the owner can act immediately.
    const owned = await request(app)
      .get('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .expect(200);
    expect((owned.body.data as unknown[]).length).toBe(1);

    // The market counter was incremented in the same transaction.
    const market = await request(app).get(`/api/v1/markets/${marketId}`).expect(200);
    expect((market.body.data as { shopCount: number }).shopCount).toBe(1);
  });

  it('publishes a shop when a moderator approves it', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;

    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);

    const publicView = await request(app).get(`/api/v1/shops/${shopId}`).expect(200);
    expect((publicView.body.data as { isVisible: boolean }).isVisible).toBe(true);
    // The public projection must not leak moderation internals.
    expect(publicView.body.data).not.toHaveProperty('moderationStatus');
  });

  it('requires a reason to reject and records it', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;

    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: false })
      .expect(422);

    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: false, reason: 'Photos do not show the stall' })
      .expect(200);

    const audit = await mongoose.connection.db
      ?.collection('audit_logs')
      .findOne({ action: 'shop.moderation_rejected' });
    expect(audit?.reason).toBe('Photos do not show the stall');
  });

  it('hides every shop in a market when the market closes', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    await request(app).get(`/api/v1/shops/${shopId}`).expect(200);

    const closed = await request(app)
      .post(`/api/v1/admin/markets/${marketId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'TEMPORARILY_CLOSED', reason: 'Reconstruction works' })
      .expect(200);
    expect((closed.body.data as { shopsAffected: number }).shopsAffected).toBe(1);

    // The cascade must be immediate: a closed market with visible shops is a business-rule
    // violation, not a staleness inconvenience.
    await request(app).get(`/api/v1/shops/${shopId}`).expect(404);
  });

  it('hides a shop immediately when the seller starts a vacation', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);

    await request(app)
      .post(`/api/v1/seller/shops/${shopId}/vacation`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ until: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(200);
    await request(app).get(`/api/v1/shops/${shopId}`).expect(404);

    await request(app)
      .post(`/api/v1/seller/shops/${shopId}/vacation`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ until: null })
      .expect(200);
    await request(app).get(`/api/v1/shops/${shopId}`).expect(200);
  });

  it('refuses a duplicate stall in the same market', async () => {
    const marketId = await createMarket();
    const payload = {
      marketId,
      name: { uz: 'Aziz sabzavot' },
      contactPhone: '+998901234567',
      sectionCode: 'B',
      stallNo: '42',
    };
    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send(payload)
      .expect(201);

    const otherToken = await createUser('+998901110001', ['SELLER_OWNER', 'BUYER']);
    const conflict = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(payload)
      .expect(409);
    expect(conflict.body.code).toBe('RESOURCE_CONFLICT');
  });

  it('refuses a section code that does not exist in the market', async () => {
    const marketId = await createMarket();
    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        marketId,
        name: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        sectionCode: 'ZZ',
      })
      .expect(422);
  });

  it('reports another seller\'s shop as missing rather than forbidden', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;

    const intruderToken = await createUser('+998901110002', ['SELLER_OWNER', 'BUYER']);
    const response = await request(app)
      .get(`/api/v1/seller/shops/${shopId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .expect(404);
    // 403 here would confirm the shop exists and turn id iteration into an inventory count.
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('adds and removes staff, and keeps their access in step', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;

    const staffPhone = '+998901110009';
    const staffToken = await createUser(staffPhone, ['BUYER']);

    await request(app)
      .post(`/api/v1/seller/shops/${shopId}/members`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ phone: staffPhone, role: 'STAFF' })
      .expect(201);

    // Permissions are resolved per request from Redis, so the new role is live at once —
    // but the cached identity must be refreshed, which happens on the next cache expiry or
    // explicit invalidation. Re-authenticating proves the persisted state is right.
    const staffTokenAfter = await (async () => {
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: staffPhone, password: 'a-good-long-password', deviceId: 'staff-device-2' })
        .expect(200);
      return (login.body.data as { accessToken: string }).accessToken;
    })();
    expect(staffToken).not.toBe(staffTokenAfter);

    const user = await mongoose.connection.db?.collection('users').findOne({ phone: staffPhone });
    expect((user?.shopIds as unknown[]).length).toBe(1);
    expect(user?.roles).toContain('SELLER_STAFF');

    await request(app)
      .delete(`/api/v1/seller/shops/${shopId}/members/${String(user?._id)}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .expect(204);

    const after = await mongoose.connection.db?.collection('users').findOne({ phone: staffPhone });
    expect((after?.shopIds as unknown[]).length).toBe(0);
    // With no shops left, the seller role is withdrawn too.
    expect(after?.roles).not.toContain('SELLER_STAFF');
  });

  it('refuses to remove the owner', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;
    const owner = await mongoose.connection.db?.collection('users').findOne({ phone: sellerPhone });

    await request(app)
      .delete(`/api/v1/seller/shops/${shopId}/members/${String(owner?._id)}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .expect(409);
  });

  it('returns a shop to moderation when its displayed name changes', async () => {
    const marketId = await createMarket();
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const shopId = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);

    const updated = await request(app)
      .patch(`/api/v1/seller/shops/${shopId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ name: { uz: 'Aziz meva-sabzavot' } })
      .expect(200);
    expect((updated.body.data as { moderationStatus: string }).moderationStatus).toBe('PENDING');
    // Re-moderation removes it from the public catalogue until reviewed again.
    await request(app).get(`/api/v1/shops/${shopId}`).expect(404);

    // A contact-detail change does not, since it is not part of the displayed identity.
    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    const phoneChange = await request(app)
      .patch(`/api/v1/seller/shops/${shopId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ contactPhone: '+998907654321' })
      .expect(200);
    expect((phoneChange.body.data as { moderationStatus: string }).moderationStatus).toBe('APPROVED');
  });

  it('paginates shops with a stable keyset cursor', async () => {
    const marketId = await createMarket();
    for (let i = 0; i < 5; i += 1) {
      const token = await createUser(`+99890222000${i}`, ['SELLER_OWNER', 'BUYER']);
      const created = await request(app)
        .post('/api/v1/seller/shops')
        .set('Authorization', `Bearer ${token}`)
        .send({ marketId, name: { uz: `Do'kon ${i}` }, contactPhone: '+998901234567' })
        .expect(201);
      await request(app)
        .post(`/api/v1/admin/shops/${(created.body.data as { id: string }).id}/moderate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true })
        .expect(200);
    }

    const first = await request(app)
      .get(`/api/v1/markets/${marketId}/shops`)
      .query({ limit: 2 })
      .expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.cursor.hasMore).toBe(true);

    const second = await request(app)
      .get(`/api/v1/markets/${marketId}/shops`)
      .query({ limit: 2, cursor: first.body.meta.cursor.next })
      .expect(200);
    expect(second.body.data).toHaveLength(2);

    const firstIds = (first.body.data as Array<{ id: string }>).map((s) => s.id);
    const secondIds = (second.body.data as Array<{ id: string }>).map((s) => s.id);
    // No overlap: the defining property that offset pagination cannot guarantee.
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it('refuses to let a caller enumerate hidden shops via the filter', async () => {
    const marketId = await createMarket();
    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);

    // isVisible is forced server-side, so this filter cannot surface unmoderated shops.
    const response = await request(app)
      .get('/api/v1/shops')
      .query({ isVisible: 'false' })
      .expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('denies shop creation to a buyer', async () => {
    const marketId = await createMarket();
    const buyerToken = await createUser('+998903330000', ['BUYER']);
    const response = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(403);
    // Missing permission key is 403: the endpoint's existence is public, so nothing leaks.
    expect(response.body.code).toBe('PERM_DENIED');
  });

  it('writes a domain event to the outbox inside the shop-creation transaction', async () => {
    const marketId = await createMarket();
    await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);

    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'shop.created' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events?.[0]?.publishedAt).toBeNull();
  });
});
