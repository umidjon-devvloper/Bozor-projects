import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Catalog integration tests.
 *
 * Requires MinIO because a product without images is not a product: image resolution runs
 * through the real media pipeline, and the derivative URLs on the response come from it.
 */
describe('catalog', () => {
  let app: Express;
  let minio: StartedTestContainer;
  let sellerToken: string;
  let adminToken: string;
  let shopId: string;
  let categoryId: string;

  const SELLER_PHONE = '+998908880001';

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
    const logger = createLogger({ service: 'seed', level: 'silent', pretty: false });
    const { seedGeography } = await import('../../src/seed/seedGeo.js');
    const { seedCatalog } = await import('../../src/seed/seedCatalog.js');
    await seedGeography(logger);
    await seedCatalog(logger);

    adminToken = await createUser('+998908880009', ['ADMIN', 'BUYER']);
    sellerToken = await createUser(SELLER_PHONE, ['SELLER_OWNER', 'BUYER']);
    const marketId = await createMarket();
    shopId = await createShop(marketId);

    const category = await mongoose.connection.db
      ?.collection('categories')
      .findOne({ slug: 'sabzavotlar' });
    categoryId = String(category?._id);
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

  async function createMarket(): Promise<string> {
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

  async function createShop(marketId: string): Promise<string> {
    const created = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ marketId, name: { uz: 'Aziz sabzavot' }, contactPhone: '+998901234567' })
      .expect(201);
    const id = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${id}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    // The seller's cached identity now includes the shop; re-authenticate to pick it up.
    sellerToken = await (async () => {
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ phone: SELLER_PHONE, password: 'a-good-long-password', deviceId: 'after-shop' })
        .expect(200);
      return (login.body.data as { accessToken: string }).accessToken;
    })();
    return id;
  }

  async function uploadImage(): Promise<string> {
    const jpeg = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 60, b: 40 } },
    })
      .jpeg()
      .toBuffer();
    const ticket = await request(app)
      .post('/api/v1/media/upload-url')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ purpose: 'PRODUCT_IMAGE', contentType: 'image/jpeg', sizeBytes: jpeg.length })
      .expect(201);
    const { mediaKey, uploadUrl } = ticket.body.data as { mediaKey: string; uploadUrl: string };
    await fetch(uploadUrl, {
      method: 'PUT',
      body: jpeg,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(jpeg.length) },
    });
    await request(app)
      .post('/api/v1/media/confirm')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ mediaKey })
      .expect(200);
    return mediaKey;
  }

  async function createProduct(overrides: Record<string, unknown> = {}): Promise<request.Response> {
    const image = await uploadImage();
    return request(app)
      .post('/api/v1/seller/products')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        shopId,
        categoryId,
        name: { uz: 'Pomidor (mahalliy)' },
        images: [image],
        unit: 'kg',
        price: '1800000',
        stockQty: '45000',
        minOrderQty: '500',
        stepQty: '500',
        attributes: { grade: '1' },
        ...overrides,
      });
  }

  async function approve(productId: string): Promise<void> {
    await request(app)
      .post(`/api/v1/admin/products/${productId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
  }

  it('seeds units and the category tree', async () => {
    const units = await request(app).get('/api/v1/units').expect(200);
    const codes = (units.body.data as Array<{ code: string }>).map((u) => u.code);
    expect(codes).toEqual(expect.arrayContaining(['kg', 'dona', 'bogh', 'litr']));

    const tree = await request(app).get('/api/v1/categories/tree').expect(200);
    const roots = tree.body.data as Array<{ slug: string; children: unknown[] }>;
    const food = roots.find((node) => node.slug === 'oziq-ovqat');
    expect(food?.children.length).toBeGreaterThan(5);
  }, 60_000);

  it('creates a product that stays hidden until moderated', async () => {
    const created = await createProduct();
    expect(created.status).toBe(201);
    const product = created.body.data as { id: string; status: string; isVisible: boolean };
    expect(product.status).toBe('PENDING_MODERATION');
    expect(product.isVisible).toBe(false);

    await request(app).get(`/api/v1/products/${product.id}`).expect(404);

    await approve(product.id);
    const published = await request(app).get(`/api/v1/products/${product.id}`).expect(200);
    expect((published.body.data as { isPurchasable: boolean }).isPurchasable).toBe(true);
    // The public projection must not leak moderation internals.
    expect(published.body.data).not.toHaveProperty('moderationStatus');
    expect(published.body.data).not.toHaveProperty('stockQty');
  }, 90_000);

  it('stores money and quantity as Int64, never as a double', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    const raw = await mongoose.connection.db
      ?.collection('products')
      .findOne({ _id: new mongoose.Types.ObjectId(productId) });

    // The BSON driver surfaces Int64 as Long; a Double here would mean silent tiyin loss.
    expect(raw?.price?._bsontype ?? typeof raw?.price).toMatch(/Long|bigint/);
    expect(String(raw?.price)).toBe('1800000');
    expect(String(raw?.stockQtyMilli)).toBe('45000');
  }, 90_000);

  it('returns money and quantity as strings of minor units', async () => {
    const created = await createProduct();
    await approve((created.body.data as { id: string }).id);
    const response = await request(app)
      .get(`/api/v1/products/${(created.body.data as { id: string }).id}`)
      .expect(200);
    const body = response.body.data as {
      price: { amount: string; currency: string };
      availableQty: { value: string; unit: string };
    };
    // ADR-0028: strings, so no JSON parser can truncate them.
    expect(body.price).toEqual({ amount: '1800000', currency: 'UZS' });
    expect(body.availableQty).toEqual({ value: '45000', unit: 'kg' });
  }, 90_000);

  it('rejects a minimum order that is not a whole number of steps', async () => {
    const response = await createProduct({ minOrderQty: '500', stepQty: '300' });
    expect(response.status).toBe(422);
    expect(response.body.errors?.[0]?.code).toBe('NOT_A_MULTIPLE_OF_STEP');
  }, 90_000);

  it('rejects a fractional quantity for a countable unit', async () => {
    const eggs = await mongoose.connection.db?.collection('categories').findOne({ slug: 'tuxum' });
    const response = await createProduct({
      categoryId: String(eggs?._id),
      unit: 'dona',
      minOrderQty: '1500',
      stepQty: '1000',
      stockQty: '30000',
      attributes: {},
    });
    // Half an egg is not an order.
    expect(response.status).toBe(422);
    expect(response.body.errors?.[0]?.code).toBe('FRACTIONAL_NOT_ALLOWED');
  }, 90_000);

  it('rejects a unit the category does not accept', async () => {
    const response = await createProduct({ unit: 'metr' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CATALOG_UNIT_NOT_ALLOWED');
  }, 90_000);

  it('validates attributes against the category schema, including inherited ones', async () => {
    // `grade` is declared on Sabzavotlar; `origin` is inherited from Oziq-ovqat.
    const ok = await createProduct({ attributes: { grade: 'oliy', origin: 'Surxondaryo' } });
    expect(ok.status).toBe(201);

    const bad = await createProduct({ attributes: { grade: 'nonexistent' } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CATALOG_ATTRIBUTE_INVALID');
  }, 90_000);

  it('records price history and does not re-moderate on a price change', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    await approve(productId);

    await request(app)
      .patch(`/api/v1/seller/products/${productId}/price`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: '2000000' })
      .expect(200);

    const stillVisible = await request(app).get(`/api/v1/products/${productId}`).expect(200);
    expect((stillVisible.body.data as { price: { amount: string } }).price.amount).toBe('2000000');

    const history = await request(app)
      .get(`/api/v1/products/${productId}/price-history`)
      .expect(200);
    const entries = history.body.data as Array<{ price: string }>;
    expect(entries.map((entry) => entry.price)).toEqual(['1800000', '2000000']);
  }, 90_000);

  it('returns a product to moderation when its name changes', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    await approve(productId);
    await request(app).get(`/api/v1/products/${productId}`).expect(200);

    await request(app)
      .patch(`/api/v1/seller/products/${productId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ name: { uz: 'Pomidor (issiqxona)' } })
      .expect(200);

    await request(app).get(`/api/v1/products/${productId}`).expect(404);
  }, 90_000);

  it('moves a product out of stock and back automatically', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    await approve(productId);

    const emptied = await request(app)
      .patch(`/api/v1/seller/products/${productId}/stock`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ stockQty: '0' })
      .expect(200);
    expect((emptied.body.data as { status: string }).status).toBe('OUT_OF_STOCK');

    // Still listed — a shopper should see it and be able to favourite it for a restock.
    const listed = await request(app).get(`/api/v1/products/${productId}`).expect(200);
    expect((listed.body.data as { isPurchasable: boolean }).isPurchasable).toBe(false);
    expect((listed.body.data as { inStock: boolean }).inStock).toBe(false);

    const restocked = await request(app)
      .patch(`/api/v1/seller/products/${productId}/stock`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ stockQty: '20000' })
      .expect(200);
    expect((restocked.body.data as { status: string }).status).toBe('ACTIVE');
  }, 90_000);

  it('treats a remainder below the minimum order as out of stock', async () => {
    const created = await createProduct({ minOrderQty: '500', stepQty: '500' });
    const productId = (created.body.data as { id: string }).id;
    await approve(productId);

    const remainder = await request(app)
      .patch(`/api/v1/seller/products/${productId}/stock`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ stockQty: '200' })
      .expect(200);
    expect((remainder.body.data as { status: string }).status).toBe('OUT_OF_STOCK');
  }, 90_000);

  it('hides a shop\'s products when the shop is hidden', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    await approve(productId);
    await request(app).get(`/api/v1/products/${productId}`).expect(200);

    // The geo module writes shop.visibility_changed to the outbox; the worker's handler is
    // what carries it to products, so the handler is exercised directly here.
    await request(app)
      .post(`/api/v1/seller/shops/${shopId}/vacation`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ until: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(200);

    const { createLogger } = await import('@bozorlar/logger');
    const { createShopVisibilityHandler } = await import(
      '../../../worker/src/handlers/shopVisibilityHandler.js'
    );
    const handler = createShopVisibilityHandler(
      createLogger({ service: 'test', level: 'silent', pretty: false }),
    );
    await handler({
      eventId: 'e1',
      type: 'shop.visibility_changed',
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { shopId, isVisible: false },
      traceId: null,
      occurredAt: new Date(),
    });

    await request(app).get(`/api/v1/products/${productId}`).expect(404);

    // Restoring the shop must not blanket-publish: this product was approved, so it returns.
    await handler({
      eventId: 'e2',
      type: 'shop.visibility_changed',
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { shopId, isVisible: true },
      traceId: null,
      occurredAt: new Date(),
    });
    await request(app).get(`/api/v1/products/${productId}`).expect(200);
  }, 90_000);

  it('does not publish an unmoderated product when its shop reappears', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;

    const { createLogger } = await import('@bozorlar/logger');
    const { createShopVisibilityHandler } = await import(
      '../../../worker/src/handlers/shopVisibilityHandler.js'
    );
    const handler = createShopVisibilityHandler(
      createLogger({ service: 'test', level: 'silent', pretty: false }),
    );
    await handler({
      eventId: 'e3',
      type: 'shop.visibility_changed',
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { shopId, isVisible: true },
      traceId: null,
      occurredAt: new Date(),
    });

    await request(app).get(`/api/v1/products/${productId}`).expect(404);
  }, 90_000);

  it('filters and sorts by price with a stable keyset cursor', async () => {
    for (const price of ['1000000', '2000000', '3000000']) {
      const created = await createProduct({ price, name: { uz: `Pomidor ${price}` } });
      await approve((created.body.data as { id: string }).id);
    }

    const cheap = await request(app)
      .get('/api/v1/products')
      .query({ 'price[lte]': '2000000', sort: 'price' })
      .expect(200);
    const amounts = (cheap.body.data as Array<{ price: { amount: string } }>).map((p) => p.price.amount);
    expect(amounts).toEqual(['1000000', '2000000']);

    const first = await request(app)
      .get('/api/v1/products')
      .query({ sort: 'price', limit: 2 })
      .expect(200);
    expect(first.body.meta.cursor.hasMore).toBe(true);
    const second = await request(app)
      .get('/api/v1/products')
      .query({ sort: 'price', limit: 2, cursor: first.body.meta.cursor.next })
      .expect(200);
    const firstIds = (first.body.data as Array<{ id: string }>).map((p) => p.id);
    const secondIds = (second.body.data as Array<{ id: string }>).map((p) => p.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  }, 120_000);

  it('rejects a filter that is not allowlisted', async () => {
    const response = await request(app)
      .get('/api/v1/products')
      .query({ moderationStatus: 'PENDING' })
      .expect(422);
    expect(response.body.code).toBe('FILTER_FIELD_NOT_ALLOWED');
  }, 60_000);

  it('reports another seller\'s product as missing rather than forbidden', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    const intruder = await createUser('+998908880002', ['SELLER_OWNER', 'BUYER']);

    const response = await request(app)
      .get(`/api/v1/seller/products/${productId}`)
      .set('Authorization', `Bearer ${intruder}`)
      .expect(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
  }, 90_000);

  it('attaches product images inside the creation transaction', async () => {
    const created = await createProduct();
    const productId = (created.body.data as { id: string }).id;
    const assets = await mongoose.connection.db
      ?.collection('media_assets')
      .find({ 'attachedTo.id': productId })
      .toArray();
    expect(assets).toHaveLength(1);
    expect(assets?.[0]?.status).toBe('ATTACHED');
  }, 90_000);

  it('refuses to deactivate a category that still holds products', async () => {
    const created = await createProduct();
    await approve((created.body.data as { id: string }).id);

    const response = await request(app)
      .delete(`/api/v1/admin/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
  }, 90_000);

  it('propagates a category rename into its descendants', async () => {
    const food = await mongoose.connection.db?.collection('categories').findOne({ slug: 'oziq-ovqat' });
    await request(app)
      .patch(`/api/v1/admin/categories/${String(food?._id)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: { uz: 'Oziq-ovqat mahsulotlari' } })
      .expect(200);

    const child = await mongoose.connection.db?.collection('categories').findOne({ slug: 'sabzavotlar' });
    const ancestor = (child?.ancestors as Array<{ name: { uz: string } }>)[0];
    expect(ancestor?.name.uz).toBe('Oziq-ovqat mahsulotlari');
  }, 90_000);

  it('denies product creation to a buyer', async () => {
    const buyer = await createUser('+998908880003', ['BUYER']);
    const response = await request(app)
      .post('/api/v1/seller/products')
      .set('Authorization', `Bearer ${buyer}`)
      .send({ shopId, categoryId, name: { uz: 'X' }, images: ['x'], unit: 'kg', price: '1', stockQty: '1', minOrderQty: '1', stepQty: '1' })
      .expect(403);
    expect(response.body.code).toBe('PERM_DENIED');
  }, 60_000);

  it('writes a domain event inside the creation transaction', async () => {
    await createProduct();
    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'product.created' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events?.[0]?.publishedAt).toBeNull();
  }, 90_000);
});
