import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/** Full order lifecycle against a real replica set and real MinIO. */
describe('orders', () => {
  let app: Express;
  let minio: StartedTestContainer;
  let sellerToken: string;
  let adminToken: string;
  let buyerToken: string;
  let shopId: string;
  let categoryId: string;
  let productId: string;

  const SELLER_PHONE = '+998911110001';
  const BUYER_PHONE = '+998911110002';

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

    adminToken = await createUser('+998911110009', ['ADMIN', 'BUYER']);
    sellerToken = await createUser(SELLER_PHONE, ['SELLER_OWNER', 'BUYER']);
    buyerToken = await createUser(BUYER_PHONE, ['BUYER']);

    const district = await mongoose.connection.db?.collection('districts').findOne({ code: 'TSH-SHA' });
    const market = await request(app)
      .post('/api/v1/admin/markets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        districtId: String(district?._id),
        name: { uz: 'Chorsu bozori' },
        address: { uz: 'Chorsu 1' },
        location: { lat: 41.3262, lng: 69.2348 },
        workingHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday, opensAt: '00:00', closesAt: '23:59', isClosed: false,
        })),
      })
      .expect(201);

    const shop = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        marketId: (market.body.data as { id: string }).id,
        name: { uz: 'Aziz sabzavot' },
        contactPhone: '+998901234567',
        sectionCode: undefined,
      })
      .expect(201);
    shopId = (shop.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${shopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    sellerToken = await login(SELLER_PHONE, 'after-shop');

    const category = await mongoose.connection.db?.collection('categories').findOne({ slug: 'sabzavotlar' });
    categoryId = String(category?._id);
    productId = await createProduct();
  });

  async function login(phone: string, deviceId: string): Promise<string> {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ phone, password: 'a-good-long-password', deviceId })
      .expect(200);
    return (response.body.data as { accessToken: string }).accessToken;
  }

  async function createUser(phone: string, roles: string[]): Promise<string> {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        phone,
        password: 'a-good-long-password',
        firstName: 'Test',
        consents: { terms: 'v1', privacy: 'v1', marketing: false },
      })
      .expect(201);
    await mongoose.connection.db
      ?.collection('users')
      .updateOne({ phone }, { $set: { phoneVerifiedAt: new Date(), roles } });
    return login(phone, `device-${phone}`);
  }

  async function createProduct(): Promise<string> {
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 40 } },
    }).jpeg().toBuffer();
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

    const created = await request(app)
      .post('/api/v1/seller/products')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({
        shopId,
        categoryId,
        name: { uz: 'Pomidor' },
        images: [mediaKey],
        unit: 'kg',
        price: '1800000',
        stockQty: '45000',
        minOrderQty: '500',
        stepQty: '500',
        attributes: { grade: '1' },
      })
      .expect(201);
    const id = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/products/${id}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    return id;
  }

  async function quoteFor(qty = '2500'): Promise<string> {
    await request(app)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ productId, qty })
      .expect(201);
    const quoted = await request(app)
      .post('/api/v1/checkout/quote')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({})
      .expect(200);
    return (quoted.body.data as { quoteId: string }).quoteId;
  }

  const placeOrder = (quoteId: string, key = randomUUID()) =>
    request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .send({ quoteId });

  async function orderFromQuote(): Promise<string> {
    const created = await placeOrder(await quoteFor()).expect(201);
    return (created.body.data as { orders: Array<{ id: string }> }).orders[0]!.id;
  }

  // `object` rather than `unknown`: supertest's `send` is typed `string | object`.
  // Type-only change (repository recovery); every call site already passes an object.
  const sellerPost = (orderId: string, action: string, body: object = {}) =>
    request(app)
      .post(`/api/v1/seller/orders/${orderId}/${action}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send(body);

  const stockOf = async (): Promise<{ stock: string; reserved: string }> => {
    const doc = await mongoose.connection.db
      ?.collection('products')
      .findOne({ _id: new mongoose.Types.ObjectId(productId) });
    return { stock: String(doc?.stockQtyMilli), reserved: String(doc?.reservedQtyMilli) };
  };

  it('creates an order group from a quote and commits the stock', async () => {
    expect(await stockOf()).toEqual({ stock: '45000', reserved: '0' });
    const quoteId = await quoteFor();
    expect(await stockOf()).toEqual({ stock: '45000', reserved: '2500' });

    const created = await placeOrder(quoteId).expect(201);
    const body = created.body.data as {
      groupNo: string;
      orders: Array<{ orderNo: string; status: string; totals: { grand: { amount: string } } }>;
    };
    expect(body.groupNo).toMatch(/^BZG-\d{6}-\d{6}$/);
    expect(body.orders[0]?.orderNo).toMatch(/^BZ-\d{6}-\d{6}$/);
    expect(body.orders[0]?.status).toBe('PENDING');
    expect(body.orders[0]?.totals.grand.amount).toBe('4500000');

    // The hold converted into a real decrement: stock leaves the shelf at order time.
    expect(await stockOf()).toEqual({ stock: '42500', reserved: '0' });

    const quote = await mongoose.connection.db?.collection('checkout_quotes').findOne({ quoteId });
    expect(quote?.status).toBe('CONSUMED');
  }, 150_000);

  it('freezes the shop and product details onto the order', async () => {
    const orderId = await orderFromQuote();
    await request(app)
      .patch(`/api/v1/seller/products/${productId}/price`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: '9900000' })
      .expect(200);

    const order = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    const body = order.body.data as {
      lines: Array<{ unitPrice: { amount: string } }>;
      shop: { name: string; phone: string | null };
    };
    // A later price change must not rewrite a receipt.
    expect(body.lines[0]?.unitPrice.amount).toBe('1800000');
    expect(body.shop.name).toBe('Aziz sabzavot');
  }, 150_000);

  it('is idempotent: a retried creation returns the first order, not a second', async () => {
    const quoteId = await quoteFor();
    const key = randomUUID();

    const first = await placeOrder(quoteId, key).expect(201);
    const replay = await placeOrder(quoteId, key).expect(201);

    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((replay.body.data as { groupNo: string }).groupNo).toBe(
      (first.body.data as { groupNo: string }).groupNo,
    );
    expect(await mongoose.connection.db?.collection('orders').countDocuments()).toBe(1);
  }, 150_000);

  it('rejects the same key with a different body', async () => {
    const key = randomUUID();
    await placeOrder(await quoteFor(), key).expect(201);
    const conflict = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .send({ quoteId: 'q_aaaaaaaaaaaaaaaaaaaaaaaa' })
      .expect(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  }, 150_000);

  it('requires an idempotency key at all', async () => {
    const response = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quoteId: await quoteFor() })
      .expect(400);
    expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  }, 150_000);

  it('refuses a quote whose prices moved, listing what changed', async () => {
    const quoteId = await quoteFor();
    await request(app)
      .patch(`/api/v1/seller/products/${productId}/price`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: '2000000' })
      .expect(200);

    const stale = await placeOrder(quoteId).expect(409);
    expect(stale.body.code).toBe('CHECKOUT_QUOTE_STALE');
    // The buyer must never be charged a figure they were not shown.
    expect(stale.body.changed?.[0]).toMatchObject({ from: '1800000', to: '2000000' });
  }, 150_000);

  it('cannot spend the same quote twice', async () => {
    const quoteId = await quoteFor();
    await placeOrder(quoteId).expect(201);
    const second = await placeOrder(quoteId).expect(410);
    expect(second.body.code).toBe('CHECKOUT_QUOTE_EXPIRED');
  }, 150_000);

  it('runs the full happy path to completion', async () => {
    const orderId = await orderFromQuote();

    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    const ready = await sellerPost(orderId, 'ready').expect(200);
    expect((ready.body.data as { status: string }).status).toBe('READY_FOR_PICKUP');

    const code = await request(app)
      .get(`/api/v1/orders/${orderId}/pickup-code`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    const pickupCode = (code.body.data as { code: string }).code;
    expect(pickupCode).toMatch(/^\d{6}$/);
    expect(code.headers['cache-control']).toContain('no-store');

    const pickedUp = await sellerPost(orderId, 'verify-pickup', { code: pickupCode }).expect(200);
    expect((pickedUp.body.data as { status: string }).status).toBe('PICKED_UP');

    const completed = await request(app)
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect((completed.body.data as { status: string }).status).toBe('COMPLETED');

    // The wallet module charges commission from this event.
    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'order.completed' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events?.[0]?.payload).toMatchObject({ total: '4500000' });
  }, 180_000);

  it('refuses a wrong pickup code and locks out after five tries', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    await sellerPost(orderId, 'ready').expect(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await sellerPost(orderId, 'verify-pickup', { code: '000000' });
      expect(wrong.status).toBe(422);
      expect(wrong.body.code).toBe('ORDER_PICKUP_CODE_INVALID');
    }
    const locked = await sellerPost(orderId, 'verify-pickup', { code: '000000' }).expect(429);
    expect(locked.body.code).toBe('ORDER_PICKUP_CODE_ATTEMPTS_EXCEEDED');
  }, 180_000);

  it('refuses transitions taken out of order', async () => {
    const orderId = await orderFromQuote();
    const early = await sellerPost(orderId, 'ready').expect(409);
    expect(early.body.code).toBe('ORDER_INVALID_TRANSITION');
  }, 150_000);

  it('applies a within-tolerance weight change without asking the buyer', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    const ready = await sellerPost(orderId, 'ready').expect(200);
    const lineId = (ready.body.data as { lines: Array<{ lineId: string }> }).lines[0]!.lineId;

    // 2.38 kg against 2.5 is 4.8%, inside the category's 10% tolerance.
    const adjusted = await sellerPost(orderId, 'adjustment', {
      lines: [{ lineId, confirmedQty: '2380' }],
    }).expect(200);
    const body = adjusted.body.data as {
      requiresBuyerApproval: boolean;
      status: string;
      totals: { grand: { amount: string } };
    };
    expect(body.requiresBuyerApproval).toBe(false);
    // 2.38 kg at 18 000.00 = 42 840.00 UZS.
    expect(body.totals.grand.amount).toBe('4284000');
  }, 180_000);

  it('holds a beyond-tolerance change for buyer approval', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    const ready = await sellerPost(orderId, 'ready').expect(200);
    const lineId = (ready.body.data as { lines: Array<{ lineId: string }> }).lines[0]!.lineId;

    // 1.5 kg against 2.5 is 40% short.
    const proposed = await sellerPost(orderId, 'adjustment', {
      lines: [{ lineId, confirmedQty: '1500' }],
    }).expect(200);
    expect((proposed.body.data as { requiresBuyerApproval: boolean }).requiresBuyerApproval).toBe(true);
    expect((proposed.body.data as { status: string }).status).toBe('PENDING_ADJUSTMENT');

    const approved = await request(app)
      .post(`/api/v1/orders/${orderId}/adjustment`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ approved: true })
      .expect(200);
    const body = approved.body.data as { status: string; totals: { grand: { amount: string } } };
    expect(body.status).toBe('PICKED_UP');
    expect(body.totals.grand.amount).toBe('2700000');
  }, 180_000);

  it('cancels the order when the buyer rejects an adjustment, without penalty', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    const ready = await sellerPost(orderId, 'ready').expect(200);
    const lineId = (ready.body.data as { lines: Array<{ lineId: string }> }).lines[0]!.lineId;
    await sellerPost(orderId, 'adjustment', { lines: [{ lineId, confirmedQty: '1000' }] }).expect(200);

    const rejected = await request(app)
      .post(`/api/v1/orders/${orderId}/adjustment`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ approved: false })
      .expect(200);
    expect((rejected.body.data as { status: string }).status).toBe('CANCELLED');

    const stored = await mongoose.connection.db
      ?.collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    // The goods were not as ordered; that is nobody misbehaving.
    expect(stored?.cancelPenalised).toBe(false);
  }, 180_000);

  it('lets a buyer cancel freely while pending and returns the stock', async () => {
    const orderId = await orderFromQuote();
    expect((await stockOf()).stock).toBe('42500');

    await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reasonCode: 'CHANGED_MIND' })
      .expect(200);

    const stored = await mongoose.connection.db
      ?.collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    expect(stored?.status).toBe('CANCELLED');
    expect(stored?.cancelPenalised).toBe(false);
  }, 150_000);

  it('penalises a buyer who abandons goods already made ready', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    await sellerPost(orderId, 'ready').expect(200);

    const noReason = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reasonCode: 'CHANGED_MIND' })
      .expect(422);
    expect(noReason.body.code).toBe('ORDER_CANCEL_REASON_REQUIRED');

    await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reasonCode: 'CHANGED_MIND', reason: 'Could not get to the market' })
      .expect(200);
    const stored = await mongoose.connection.db
      ?.collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    expect(stored?.cancelPenalised).toBe(true);
  }, 180_000);

  it('refuses cancellation once the goods have changed hands', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    await sellerPost(orderId, 'ready').expect(200);
    const code = await request(app)
      .get(`/api/v1/orders/${orderId}/pickup-code`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    await sellerPost(orderId, 'verify-pickup', { code: (code.body.data as { code: string }).code }).expect(200);

    const refused = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reasonCode: 'CHANGED_MIND', reason: 'Changed my mind afterwards' })
      .expect(409);
    expect(refused.body.code).toBe('ORDER_CANCEL_NOT_ALLOWED');
  }, 180_000);

  it('withholds contact details until the seller accepts', async () => {
    const orderId = await orderFromQuote();
    const before = await request(app)
      .get(`/api/v1/seller/orders/${orderId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .expect(200);
    expect((before.body.data as { buyer: { phone?: string } }).buyer.phone).toBeUndefined();

    await sellerPost(orderId, 'accept').expect(200);
    const after = await request(app)
      .get(`/api/v1/seller/orders/${orderId}`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .expect(200);
    expect((after.body.data as { buyer: { phone?: string } }).buyer.phone).toBe(BUYER_PHONE);
  }, 150_000);

  it('reports another buyer\'s order as missing rather than forbidden', async () => {
    const orderId = await orderFromQuote();
    const outsider = await createUser('+998911110003', ['BUYER']);
    const response = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${outsider}`)
      .expect(404);
    expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
  }, 150_000);

  it('expires an order the seller never answered and puts the stock back', async () => {
    const orderId = await orderFromQuote();
    expect((await stockOf()).stock).toBe('42500');

    await mongoose.connection.db
      ?.collection('orders')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(orderId) },
        { $set: { acceptDeadline: new Date(Date.now() - 1000) } },
      );
    // The order holds committed stock, so expiry must restore it through the reservation.
    await mongoose.connection.db?.collection('stock_reservations').insertOne({
      productId: new mongoose.Types.ObjectId(productId),
      shopId: new mongoose.Types.ObjectId(shopId),
      buyerId: new mongoose.Types.ObjectId(String((await mongoose.connection.db
        ?.collection('users').findOne({ phone: BUYER_PHONE }))?._id)),
      holderType: 'ORDER',
      holderId: orderId,
      qtyMilli: mongoose.mongo.Long.fromBigInt(2500n),
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 900_000),
      releasedAt: null,
      schemaVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { createLogger } = await import('@bozorlar/logger');
    const { createOrderTimersSweeper } = await import('../../../worker/src/orderTimersSweeper.js');
    const { Redis } = await import('ioredis');
    const sweeper = createOrderTimersSweeper(
      new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      createLogger({ service: 't', level: 'silent', pretty: false }),
    );
    expect(await sweeper.expireUnaccepted(new Date())).toBe(1);

    const stored = await mongoose.connection.db
      ?.collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    expect(stored?.status).toBe('EXPIRED');
    expect(stored?.cancelReasonCode).toBe('ACCEPT_WINDOW_EXPIRED');
  }, 180_000);

  it('auto-completes a collected order the buyer never confirmed', async () => {
    const orderId = await orderFromQuote();
    await sellerPost(orderId, 'accept').expect(200);
    await sellerPost(orderId, 'preparing').expect(200);
    await sellerPost(orderId, 'ready').expect(200);
    const code = await request(app)
      .get(`/api/v1/orders/${orderId}/pickup-code`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    await sellerPost(orderId, 'verify-pickup', { code: (code.body.data as { code: string }).code }).expect(200);

    await mongoose.connection.db
      ?.collection('orders')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(orderId) },
        { $set: { autoCompleteAt: new Date(Date.now() - 1000) } },
      );

    const { createLogger } = await import('@bozorlar/logger');
    const { createOrderTimersSweeper } = await import('../../../worker/src/orderTimersSweeper.js');
    const { Redis } = await import('ioredis');
    const sweeper = createOrderTimersSweeper(
      new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      createLogger({ service: 't', level: 'silent', pretty: false }),
    );
    expect(await sweeper.autoComplete(new Date())).toBe(1);

    const stored = await mongoose.connection.db
      ?.collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(orderId) });
    expect(stored?.status).toBe('COMPLETED');
    // Without this the seller's commission would never be charged.
    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'order.completed' })
      .toArray();
    expect(events?.[0]?.payload).toMatchObject({ autoCompleted: true });
  }, 180_000);

  it('derives the group status from its children', async () => {
    const created = await placeOrder(await quoteFor()).expect(201);
    const groupId = (created.body.data as { groupId: string }).groupId;
    const orderId = (created.body.data as { orders: Array<{ id: string }> }).orders[0]!.id;

    let group = await request(app)
      .get(`/api/v1/order-groups/${groupId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect((group.body.data as { status: string }).status).toBe('ACTIVE');

    await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ reasonCode: 'CHANGED_MIND' })
      .expect(200);

    group = await request(app)
      .get(`/api/v1/order-groups/${groupId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect((group.body.data as { status: string }).status).toBe('CANCELLED');
  }, 150_000);
});
