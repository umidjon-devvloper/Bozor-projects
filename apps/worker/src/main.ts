import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { env, isDevelopment } from '@bozorlar/config';
import { createLogger } from '@bozorlar/logger';
import { createOutboxRelay } from './outboxRelay.js';
import { createVisibilitySweeper } from './visibilitySweeper.js';
import { createOrphanMediaSweeper } from './orphanMediaSweeper.js';
import { createEventDispatcher } from './eventDispatcher.js';
import { createReservationSweeper } from './reservationSweeper.js';
import { createOrderTimersSweeper } from './orderTimersSweeper.js';
import { createShopVisibilityHandler } from './handlers/shopVisibilityHandler.js';
import { createOrderCompletedHandler } from './handlers/orderCompletedHandler.js';
import { createSellerWalletHandler } from './handlers/sellerWalletHandler.js';
import { registerNotificationHandlers } from './handlers/notificationHandlers.js';
import { registerSearchIndexHandlers } from './handlers/searchIndexHandlers.js';
import { createIndexer, createTypesenseClient } from '@bozorlar/search';
import {
  createConfiguredProviders,
  createDeliveryService,
} from '@bozorlar/notifications';
import { createSmsProvider } from './smsProvider.js';
import { createCommissionService } from '@bozorlar/ledger';
import {
  createWorkerAuditRecorder,
  createWorkerEventPublisher,
  createWorkerOrderWriter,
} from './handlers/ledgerPorts.js';
import { createStorageService } from '@bozorlar/storage';

const logger = createLogger({
  service: 'bozorlar-worker',
  level: env.LOG_LEVEL,
  pretty: isDevelopment,
});

async function bootstrap(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  logger.info('worker connected to mongodb and redis');

  const storage = createStorageService();

  const dispatcher = createEventDispatcher(logger);
  dispatcher.on('shop.visibility_changed', createShopVisibilityHandler(logger));
  // The wallet's activation state drives shop visibility, closing the loop the geo module's
  // `sellerWalletActive` flag has been waiting on.
  // Commission is charged here rather than in the API, because completion is often reached
  // by a timer rather than a request (COMMISSION_SPEC.md "Timing").
  const commissionService = createCommissionService({
    orders: createWorkerOrderWriter(),
    events: createWorkerEventPublisher(),
    audit: createWorkerAuditRecorder(),
    logger,
  });
  dispatcher.on('order.completed', createOrderCompletedHandler(commissionService, logger));

  const sellerWalletHandler = createSellerWalletHandler(logger);
  dispatcher.on('seller.deactivated', sellerWalletHandler);
  dispatcher.on('seller.reactivated', sellerWalletHandler);

  // Every event the platform has emitted since Phase 0 has been relayed to nobody. This is
  // the consumer that turns them into something a person actually sees.
  const delivery = createDeliveryService({
    providers: createConfiguredProviders((context, message) => logger.info(context, message)),
    sms: createSmsProvider(logger),
    logger,
    appBaseUrl: env.APP_DEEP_LINK_BASE,
  });
  registerNotificationHandlers((type, handler) => dispatcher.on(type, handler), delivery, logger);

  // Search is indexed from the same relayed events, so the index cannot drift from the
  // catalogue without the outbox itself having failed.
  const searchIndexer = createIndexer(
    createTypesenseClient({ url: env.TYPESENSE_URL, apiKey: env.TYPESENSE_API_KEY }),
    logger,
  );
  await searchIndexer.ensureCollections().catch((error: unknown) => {
    // A search engine that is down must not stop the worker: orders, timers and commission
    // matter more than discovery, and indexing catches up when it returns.
    logger.error({ err: error }, 'could not prepare search collections');
  });
  registerSearchIndexHandlers((type, handler) => dispatcher.on(type, handler), searchIndexer, logger);

  const relay = createOutboxRelay(logger, dispatcher);
  const sweeper = createVisibilitySweeper(redis, logger);
  const mediaSweeper = createOrphanMediaSweeper(redis, storage, logger);
  const reservationSweeper = createReservationSweeper(redis, logger);
  const orderTimers = createOrderTimersSweeper(redis, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    relay.stop();
    sweeper.stop();
    mediaSweeper.stop();
    reservationSweeper.stop();
    orderTimers.stop();
    storage.close();
    await mongoose.disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  sweeper.start();
  mediaSweeper.start();
  reservationSweeper.start();
  orderTimers.start();
  logger.info({ handledEvents: dispatcher.handledTypes() }, 'event dispatcher ready');
  await relay.start();
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
