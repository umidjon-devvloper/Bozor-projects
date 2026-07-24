import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';

/**
 * Cart and checkout integration tests.
 *
 * Includes the concurrency case `TESTING.md` lists as mandatory: two buyers racing for the
 * last of a product. That one cannot be written against a mock — it is the whole reason the
 * reservation is a conditional update rather than a read followed by a write (ADR-0032).
 */
describe('cart & checkout', () => {
  let app: Express;
  let minio: StartedTestContainer;
  let sellerToken: string;
  let adminToken: string;
  let buyerToken: string;
  let shopId: string;
  let categoryId: string;

  const SELLER_PHONE = '+998909990001';

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

    adminToken = await createUser('+998909990009', ['ADMIN', 'BUYER']);
    sellerToken = await createUser(SELLER_PHONE, ['SELLER_OWNER', 'BUYER']);
    buyerToken = await createUser('+998909990002', ['BUYER']);

    const district = await mongoose.connection.db?.collection('districts').findOne({ code: 'TSH-SHA' });
    const market = await request(app)
      .post('/api/v1/admin/markets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        districtId: String(district?._id),
        name: { uz: 'Chorsu bozori' },
        address: { uz: 'Chorsu maydoni 1' },
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

  async function createProduct(overrides: Record<string, unknown> = {}): Promise<string> {
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 60, b: 40 } },
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
        ...overrides,
      })
      .expect(201);
    const productId = (created.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/products/${productId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);
    return productId;
  }

  const addToCart = (token: string, productId: string, qty: string) =>
    request(app).post('/api/v1/cart/items').set('Authorization', `Bearer ${token}`).send({ productId, qty });

  const quote = (token: string) =>
    request(app).post('/api/v1/checkout/quote').set('Authorization', `Bearer ${token}`).send({});

  const reservedOn = async (productId: string): Promise<string> => {
    const doc = await mongoose.connection.db
      ?.collection('products')
      .findOne({ _id: new mongoose.Types.ObjectId(productId) });
    return String(doc?.reservedQtyMilli);
  };

  it('adds to the cart and prices it from the live product', async () => {
    const productId = await createProduct();
    const added = await addToCart(buyerToken, productId, '2500').expect(201);
    const cart = added.body.data as { subtotal: { amount: string }; items: unknown[] };
    // 2.5 kg at 18 000.00 = 45 000.00 UZS.
    expect(cart.subtotal.amount).toBe('4500000');
    expect(cart.items).toHaveLength(1);
  }, 120_000);

  it('increments an existing line instead of duplicating the product', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '1000').expect(201);
    const again = await addToCart(buyerToken, productId, '1500').expect(201);
    const cart = again.body.data as { items: Array<{ qty: { value: string } }> };
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]?.qty.value).toBe('2500');
  }, 120_000);

  it('rejects a quantity below the minimum or off the step', async () => {
    const productId = await createProduct();
    const belowMin = await addToCart(buyerToken, productId, '200').expect(422);
    expect(belowMin.body.code).toBe('CART_QTY_BELOW_MINIMUM');
    const offStep = await addToCart(buyerToken, productId, '750').expect(422);
    expect(offStep.body.code).toBe('CART_QTY_STEP_INVALID');
  }, 120_000);

  it('reports a price change as advisory and still quotes', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);

    await request(app)
      .patch(`/api/v1/seller/products/${productId}/price`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ price: '2000000' })
      .expect(200);

    const cart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${buyerToken}`).expect(200);
    const line = (cart.body.data as { items: Array<{ priceChanged: boolean; purchasable: boolean }> }).items[0];
    expect(line?.priceChanged).toBe(true);
    expect(line?.purchasable).toBe(true);

    const quoted = await quote(buyerToken).expect(200);
    // Priced at the live figure, and the buyer is told it moved.
    expect((quoted.body.data as { grandTotal: { amount: string } }).grandTotal.amount).toBe('5000000');
    expect((quoted.body.data as { issues: Array<{ code: string }> }).issues[0]?.code).toBe('PRICE_CHANGED');
  }, 120_000);

  it('blocks a quote when a line is no longer purchasable, naming the line', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);

    await request(app)
      .patch(`/api/v1/seller/products/${productId}/stock`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ stockQty: '1000' })
      .expect(200);

    const blocked = await quote(buyerToken).expect(409);
    expect(blocked.body.code).toBe('CHECKOUT_STOCK_CHANGED');
    expect(blocked.body.errors?.[0]?.code).toBe('INSUFFICIENT_STOCK');
  }, 120_000);

  it('reserves stock when the quote is issued', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);
    expect(await reservedOn(productId)).toBe('0');

    const quoted = await quote(buyerToken).expect(200);
    expect(await reservedOn(productId)).toBe('2500');

    const body = quoted.body.data as { quoteId: string; expiresAt: string };
    expect(body.quoteId).toMatch(/^q_[a-f0-9]{24}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const reservation = await mongoose.connection.db
      ?.collection('stock_reservations')
      .findOne({ holderId: body.quoteId });
    expect(reservation?.status).toBe('ACTIVE');
  }, 120_000);

  it('gives back the previous hold when a new quote supersedes it', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);

    const first = await quote(buyerToken).expect(200);
    expect(await reservedOn(productId)).toBe('2500');

    const second = await quote(buyerToken).expect(200);
    // Not 5000: an indecisive shopper must not hold the stock twice.
    expect(await reservedOn(productId)).toBe('2500');

    const firstId = (first.body.data as { quoteId: string }).quoteId;
    const stale = await mongoose.connection.db
      ?.collection('checkout_quotes')
      .findOne({ quoteId: firstId });
    expect(stale?.status).toBe('SUPERSEDED');
    expect((second.body.data as { quoteId: string }).quoteId).not.toBe(firstId);
  }, 120_000);

  it('lets exactly one of two buyers take the last of a product', async () => {
    // The mandatory concurrency case from TESTING.md. Stock is 2.5 kg and both buyers want
    // all of it; the conditional hold in ADR-0032 is what decides, not a read-then-write.
    const productId = await createProduct({ stockQty: '2500' });
    const secondBuyer = await createUser('+998909990003', ['BUYER']);

    await addToCart(buyerToken, productId, '2500').expect(201);
    await addToCart(secondBuyer, productId, '2500').expect(201);

    const results = await Promise.all([quote(buyerToken), quote(secondBuyer)]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);

    const loser = results.find((response) => response.status === 409);
    expect(loser?.body.code).toBe('CHECKOUT_STOCK_CHANGED');

    // Exactly one hold exists, and it accounts for all the stock — never 5000.
    expect(await reservedOn(productId)).toBe('2500');
    const active = await mongoose.connection.db
      ?.collection('stock_reservations')
      .countDocuments({ productId: new mongoose.Types.ObjectId(productId), status: 'ACTIVE' });
    expect(active).toBe(1);
  }, 150_000);

  it('leaves no hold behind when a quote fails part-way through', async () => {
    // Two lines, the second unavailable. The transaction must give back the first hold.
    const good = await createProduct({ stockQty: '45000' });
    const scarce = await createProduct({ stockQty: '2500', name: { uz: 'Bodring' } });

    await addToCart(buyerToken, good, '2500').expect(201);
    await addToCart(buyerToken, scarce, '2500').expect(201);

    const other = await createUser('+998909990004', ['BUYER']);
    await addToCart(other, scarce, '2500').expect(201);
    await quote(other).expect(200);

    await quote(buyerToken).expect(409);
    // The first line's hold was rolled back with the transaction.
    expect(await reservedOn(good)).toBe('0');
  }, 150_000);

  it('groups a multi-shop basket by seller', async () => {
    const firstProduct = await createProduct();

    const otherSellerPhone = '+998909990005';
    const otherSeller = await createUser(otherSellerPhone, ['SELLER_OWNER', 'BUYER']);
    const market = await mongoose.connection.db?.collection('markets').findOne({});
    const otherShop = await request(app)
      .post('/api/v1/seller/shops')
      .set('Authorization', `Bearer ${otherSeller}`)
      .send({ marketId: String(market?._id), name: { uz: 'Bek meva' }, contactPhone: '+998901234568' })
      .expect(201);
    const otherShopId = (otherShop.body.data as { id: string }).id;
    await request(app)
      .post(`/api/v1/admin/shops/${otherShopId}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true })
      .expect(200);

    const savedSeller = sellerToken;
    sellerToken = await login(otherSellerPhone, 'other-seller');
    const previousShop = shopId;
    shopId = otherShopId;
    const secondProduct = await createProduct({ name: { uz: 'Olma' } });
    shopId = previousShop;
    sellerToken = savedSeller;

    await addToCart(buyerToken, firstProduct, '1000').expect(201);
    await addToCart(buyerToken, secondProduct, '1000').expect(201);

    const quoted = await quote(buyerToken).expect(200);
    const groups = (quoted.body.data as { groups: Array<{ shopId: string; total: { amount: string } }> }).groups;
    // ADR-0007: one group per shop, because acceptance and pickup are per seller.
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.shopId)).size).toBe(2);
    expect((quoted.body.data as { grandTotal: { amount: string } }).grandTotal.amount).toBe('3600000');
  }, 180_000);

  it('surfaces the handover tolerance and a pickup window on every group', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);
    const quoted = await quote(buyerToken).expect(200);
    const group = (quoted.body.data as {
      groups: Array<{
        lines: Array<{ tolerancePercent: number }>;
        pickupWindow: { from: string; to: string };
      }>;
    }).groups[0];

    // The buyer sees the weighing tolerance before ordering, not for the first time at
    // handover (ADR-0006).
    expect(group?.lines[0]?.tolerancePercent).toBeGreaterThan(0);
    expect(new Date(group?.pickupWindow.to ?? 0).getTime()).toBeGreaterThan(
      new Date(group?.pickupWindow.from ?? 0).getTime(),
    );
  }, 120_000);

  it('refuses a quote for an empty basket', async () => {
    const empty = await quote(buyerToken).expect(422);
    expect(empty.body.code).toBe('CHECKOUT_EMPTY_CART');
  }, 60_000);

  it('refuses to quote when the seller has stopped trading', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);

    await request(app)
      .post(`/api/v1/seller/shops/${shopId}/vacation`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ until: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(200);

    const { createLogger } = await import('@bozorlar/logger');
    const { createShopVisibilityHandler } = await import(
      '../../../worker/src/handlers/shopVisibilityHandler.js'
    );
    await createShopVisibilityHandler(createLogger({ service: 't', level: 'silent', pretty: false }))({
      eventId: 'e1',
      type: 'shop.visibility_changed',
      aggregateType: 'shop',
      aggregateId: shopId,
      payload: { shopId, isVisible: false },
      traceId: null,
      occurredAt: new Date(),
    });

    const blocked = await quote(buyerToken).expect(409);
    expect(blocked.body.errors?.[0]?.code).toBe('SHOP_NOT_VISIBLE');
  }, 150_000);

  it('returns a stored quote to its owner and hides it from everyone else', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);
    const quoteId = (await quote(buyerToken).expect(200)).body.data.quoteId as string;

    const own = await request(app)
      .get(`/api/v1/checkout/quote/${quoteId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect((own.body.data as { grandTotal: { amount: string } }).grandTotal.amount).toBe('4500000');
    expect(own.headers['cache-control']).toContain('no-store');

    const outsider = await createUser('+998909990006', ['BUYER']);
    const denied = await request(app)
      .get(`/api/v1/checkout/quote/${quoteId}`)
      .set('Authorization', `Bearer ${outsider}`)
      .expect(404);
    expect(denied.body.code).toBe('RESOURCE_NOT_FOUND');
  }, 120_000);

  it('releases expired holds and puts the stock back on sale', async () => {
    const productId = await createProduct({ stockQty: '2500' });
    await addToCart(buyerToken, productId, '2500').expect(201);
    const quoteId = (await quote(buyerToken).expect(200)).body.data.quoteId as string;
    expect(await reservedOn(productId)).toBe('2500');

    // Age the hold past its window rather than waiting fifteen minutes.
    await mongoose.connection.db
      ?.collection('stock_reservations')
      .updateMany({ holderId: quoteId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await mongoose.connection.db
      ?.collection('checkout_quotes')
      .updateOne({ quoteId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const { createLogger } = await import('@bozorlar/logger');
    const { createReservationSweeper } = await import('../../../worker/src/reservationSweeper.js');
    const { Redis } = await import('ioredis');
    const sweeper = createReservationSweeper(
      new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      createLogger({ service: 't', level: 'silent', pretty: false }),
    );
    expect(await sweeper.sweepOnce()).toBe(1);

    // The counter went back down, not up: the TTL trap avoided.
    expect(await reservedOn(productId)).toBe('0');
    const reservation = await mongoose.connection.db
      ?.collection('stock_reservations')
      .findOne({ holderId: quoteId });
    expect(reservation?.status).toBe('EXPIRED');

    const expiredQuote = await request(app)
      .get(`/api/v1/checkout/quote/${quoteId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(410);
    expect(expiredQuote.body.code).toBe('CHECKOUT_QUOTE_EXPIRED');

    // And another buyer can now take it.
    const next = await createUser('+998909990007', ['BUYER']);
    await addToCart(next, productId, '2500').expect(201);
    await quote(next).expect(200);
  }, 180_000);

  it('merges a guest basket by adding quantities and reporting what it dropped', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '1000').expect(201);

    const merged = await request(app)
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({
        items: [
          { productId, qty: '1500' },
          { productId: '665f1a2b3c4d5e6f7a8b9c0d', qty: '1000' },
        ],
      })
      .expect(200);

    const body = merged.body.data as {
      items: Array<{ qty: { value: string } }>;
      rejected: Array<{ reason: string }>;
    };
    // Someone who added two kilos as a guest and one more after signing in wants three.
    expect(body.items[0]?.qty.value).toBe('2500');
    expect(body.rejected[0]?.reason).toBe('PRODUCT_GONE');
  }, 120_000);

  it('keeps carts separate between buyers', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);

    const other = await createUser('+998909990008', ['BUYER']);
    const theirCart = await request(app).get('/api/v1/cart').set('Authorization', `Bearer ${other}`).expect(200);
    expect((theirCart.body.data as { items: unknown[] }).items).toHaveLength(0);
  }, 120_000);

  it('requires authentication for cart and checkout', async () => {
    await request(app).get('/api/v1/cart').expect(401);
    await request(app).post('/api/v1/checkout/quote').send({}).expect(401);
  }, 60_000);

  it('writes a domain event inside the quote transaction', async () => {
    const productId = await createProduct();
    await addToCart(buyerToken, productId, '2500').expect(201);
    await quote(buyerToken).expect(200);

    const events = await mongoose.connection.db
      ?.collection('outbox')
      .find({ type: 'checkout.quoted' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events?.[0]?.publishedAt).toBeNull();
  }, 120_000);
});
