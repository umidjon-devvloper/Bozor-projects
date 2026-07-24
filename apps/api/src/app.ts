import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { Redis } from 'ioredis';
import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';
import { requestContext } from './middleware/requestContext.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authenticate, csrfProtection, optionalAuthenticate } from './middleware/auth.js';
import {
  createAuthController,
  createAuthRouter,
  createAuthService,
  createDeviceRouter,
  createOtpService,
  createSessionService,
  createSmsProvider,
  createTokenService,
  buyerSnapshot,
} from './modules/identity/index.js';
import {
  createGeoAdminRouter,
  createGeoController,
  createGeoRouter,
  createGeoService,
  createMarketService,
  createSellerShopRouter,
  createShopService,
} from './modules/geo/index.js';
import { createAuditService } from './modules/audit/index.js';
import {
  createMediaController,
  createMediaRouter,
  createMediaService,
  createVirusScanner,
} from './modules/media/index.js';
import { createStorageService } from '@bozorlar/storage';
import {
  createOrderController,
  createOrderGroupRouter,
  createOrderRouter,
  createOrderService,
  createSellerOrderRouter,
} from './modules/orders/index.js';
import { idempotency } from './middleware/idempotency.js';
import {
  createApiAuditRecorder,
  createApiEventPublisher,
  createSellerWalletRouter,
  createWalletAdminRouter,
  createWalletController,
  createWalletService,
} from './modules/wallet/index.js';
import { createCommissionService } from '@bozorlar/ledger';
import { orderCommissionWriter } from './modules/orders/index.js';
import {
  createNotificationAdminRouter,
  createNotificationController,
  createNotificationRouter,
} from './modules/notifications/index.js';
import { createConfiguredProviders, createDeliveryService } from '@bozorlar/notifications';
import {
  createSearchAdminRouter,
  createSearchController,
  createSearchRouter,
} from './modules/search/index.js';
import { createIndexer, createSearchService, createTypesenseClient } from '@bozorlar/search';
import {
  createPublicReviewRouter,
  createReviewAdminRouter,
  createReviewController,
  createReviewRouter,
  createReviewService,
} from './modules/reviews/index.js';
import { orderDisputeWriter, orderReviewLookup } from './modules/orders/index.js';
import {
  createDisputeAdminRouter,
  createDisputeController,
  createDisputeRouter,
  createDisputeService,
  createSellerDisputeRouter,
} from './modules/disputes/index.js';
import {
  createCartRouter,
  createCartService,
  createCheckoutController,
  createCheckoutRouter,
  createQuoteService,
} from './modules/checkout/index.js';
import {
  createCatalogAdminRouter,
  createCatalogController,
  createCatalogRouter,
  createCategoryService,
  createProductService,
  createSellerProductRouter,
} from './modules/catalog/index.js';
import {
  createApplicationAdminRouter,
  createApplicationRouter,
  createOnboardingController,
  createOnboardingService,
} from './modules/onboarding/index.js';
import { createConfigRouter, createHealthRouter } from './modules/platform/index.js';
import { createCache } from './shared/cache.js';

export interface AppDependencies {
  logger: Logger;
  redis: Redis;
}

/**
 * Composition root. Dependencies are constructed once here and injected downward, so no
 * module reaches for a singleton and every service is testable in isolation
 * (CONVENTIONS.md "Functions & errors").
 */
export function createApp({ logger, redis }: AppDependencies): Express {
  const app = express();

  // Required for correct req.ip behind Nginx, which in turn is what makes per-IP rate
  // limiting meaningful rather than limiting the proxy itself.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
      },
      hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type', 'Authorization', 'Accept-Language', 'X-Request-Id',
        'Idempotency-Key', 'X-Device-Id', 'X-App-Version', 'X-Platform',
        'X-CSRF-Token', 'X-Client', 'If-None-Match',
      ],
      exposedHeaders: [
        'X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After',
      ],
      maxAge: 600,
    }),
  );

  app.use(compression());
  // 256KB cap: uploads go straight to object storage, so the API never needs a large body
  // and accepting one only widens the DoS surface (API.md 1.13).
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use(cookieParser());
  app.use(requestContext);
  app.use(csrfProtection);

  // --- dependency graph ---
  const audit = createAuditService(logger);

  // identity
  const sms = createSmsProvider(logger);
  const otp = createOtpService(sms, logger);
  const tokens = createTokenService(logger);
  const sessions = createSessionService(redis);
  const authService = createAuthService({ otp, tokens, sessions, audit, logger });
  const authController = createAuthController(authService);
  const requireAuth: RequestHandler = authenticate({ tokens, sessions });
  const optionalAuth: RequestHandler = optionalAuthenticate({ tokens, sessions });

  // media
  const storage = createStorageService();
  const scanner = createVirusScanner(logger);
  const mediaService = createMediaService({ storage, scanner, audit, logger });
  const mediaController = createMediaController(mediaService);

  // geo
  const geoCache = createCache(redis, logger, 'geo');
  const geoService = createGeoService(geoCache);
  const shopService = createShopService({ cache: geoCache, audit, logger });
  const marketService = createMarketService({ cache: geoCache, audit, logger });
  const geoController = createGeoController({
    geo: geoService,
    markets: marketService,
    shops: shopService,
  });

  // onboarding
  const onboardingService = createOnboardingService({
    media: mediaService,
    // A narrow port rather than the whole geo module: onboarding only needs to know that a
    // market exists, and a wider dependency would invite it to grow one.
    markets: {
      exists: async (marketId: string) => {
        try {
          await geoService.getMarket(marketId);
          return true;
        } catch {
          return false;
        }
      },
    },
    audit,
    logger,
  });
  const onboardingController = createOnboardingController(onboardingService);

  // catalog
  const catalogCache = createCache(redis, logger, 'catalog');
  const categoryService = createCategoryService({ cache: catalogCache, audit, logger });
  const productService = createProductService({
    categories: categoryService,
    // A narrow port over the geo module: the catalogue needs a shop's geography and whether
    // it is visible, and nothing else.
    shops: { forProduct: (shopId: string) => shopService.findContext(shopId) },
    media: mediaService,
    cache: catalogCache,
    audit,
    logger,
  });
  const catalogController = createCatalogController({
    categories: categoryService,
    products: productService,
  });

  // cart & checkout
  const cartService = createCartService({ products: productService });
  const quoteService = createQuoteService({
    cart: cartService,
    shops: { findCheckoutSummaries: (ids) => shopService.findCheckoutSummaries(ids) },
    logger,
  });
  const checkoutController = createCheckoutController({ cart: cartService, quotes: quoteService });

  // orders
  const orderService = createOrderService({
    products: {
      findForCheckout: async (ids) => {
        const found = await productService.findForCheckout(ids);
        return new Map([...found].map(([id, product]) => [id, { id, price: product.price }]));
      },
    },
    buyers: { snapshot: buyerSnapshot },
    shops: { forOrder: (shopId: string) => shopService.findContext(shopId) },
    audit,
    logger,
  });
  const orderController = createOrderController(orderService);
  const requireIdempotency: RequestHandler = idempotency({ logger });

  // wallet, ledger & commission
  const commissionService = createCommissionService({
    orders: orderCommissionWriter,
    events: createApiEventPublisher(),
    audit: createApiAuditRecorder(audit),
    logger,
  });
  const walletService = createWalletService({ commission: commissionService, audit, logger });
  const walletController = createWalletController(walletService);

  // notifications
  const deliveryService = createDeliveryService({
    providers: createConfiguredProviders((context, message) => logger.info(context, message)),
    // SMS belongs to the identity module, which already owns the Eskiz adapter; the engine
    // takes it as a port rather than opening a second account with the provider.
    sms,
    logger,
    appBaseUrl: env.APP_DEEP_LINK_BASE,
  });
  const notificationController = createNotificationController(deliveryService);

  // search
  const typesense = createTypesenseClient({ url: env.TYPESENSE_URL, apiKey: env.TYPESENSE_API_KEY });
  // reviews
  const reviewService = createReviewService({
    orders: orderReviewLookup,
    media: mediaService,
    audit,
    logger,
  });
  const reviewController = createReviewController(reviewService);

  // disputes
  const disputeService = createDisputeService({
    orders: orderDisputeWriter,
    commission: commissionService,
    media: mediaService,
    audit,
    logger,
  });
  const disputeController = createDisputeController(disputeService);

  // search
  const searchController = createSearchController({
    search: createSearchService(typesense),
    indexer: createIndexer(typesense, logger),
  });

  // --- routes ---
  app.use('/health', createHealthRouter({ scanner }));
  app.use('/api/v1/config', createConfigRouter());
  app.use('/api/v1/auth', createAuthRouter(authController, requireAuth));
  app.use('/api/v1/devices', createDeviceRouter(authController, requireAuth));
  app.use('/api/v1/media', createMediaRouter(mediaController, requireAuth));
  app.use('/api/v1', createGeoRouter(geoController, { authenticate: requireAuth, optionalAuth }));
  app.use('/api/v1/seller/shops', createSellerShopRouter(geoController, requireAuth));
  app.use('/api/v1/admin', createGeoAdminRouter(geoController, requireAuth));
  app.use('/api/v1', createCatalogRouter(catalogController, { optionalAuth }));
  app.use('/api/v1/cart', createCartRouter(checkoutController, requireAuth));
  app.use('/api/v1/checkout', createCheckoutRouter(checkoutController, requireAuth));
  app.use(
    '/api/v1/orders',
    createOrderRouter(orderController, { authenticate: requireAuth, idempotency: requireIdempotency }),
  );
  app.use('/api/v1/order-groups', createOrderGroupRouter(orderController, requireAuth));
  app.use('/api/v1/seller/orders', createSellerOrderRouter(orderController, requireAuth));
  app.use('/api/v1/seller/wallet', createSellerWalletRouter(walletController, requireAuth));
  app.use('/api/v1', createPublicReviewRouter(reviewController));
  app.use('/api/v1/reviews', createReviewRouter(reviewController, requireAuth));
  app.use('/api/v1/disputes', createDisputeRouter(disputeController, requireAuth));
  app.use('/api/v1/seller/disputes', createSellerDisputeRouter(disputeController, requireAuth));
  app.use('/api/v1/admin', createDisputeAdminRouter(disputeController, requireAuth));
  app.use('/api/v1/admin', createReviewAdminRouter(reviewController, requireAuth));
  app.use('/api/v1/search', createSearchRouter(searchController));
  app.use('/api/v1/notifications', createNotificationRouter(notificationController, requireAuth));
  app.use('/api/v1/admin', createSearchAdminRouter(searchController, requireAuth));
  app.use('/api/v1/admin', createNotificationAdminRouter(notificationController, requireAuth));
  app.use(
    '/api/v1/admin',
    createWalletAdminRouter(walletController, {
      authenticate: requireAuth,
      idempotency: requireIdempotency,
    }),
  );
  app.use('/api/v1/seller/products', createSellerProductRouter(catalogController, requireAuth));
  app.use('/api/v1/admin', createCatalogAdminRouter(catalogController, requireAuth));
  app.use('/api/v1/seller/applications', createApplicationRouter(onboardingController, requireAuth));
  app.use(
    '/api/v1/admin/seller-applications',
    createApplicationAdminRouter(onboardingController, requireAuth),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
