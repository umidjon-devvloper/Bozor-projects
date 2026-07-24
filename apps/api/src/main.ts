import { createServer } from 'node:http';
import { env, isDevelopment } from '@bozorlar/config';
import { createLogger } from '@bozorlar/logger';
import { createApp } from './app.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { createRedis, disconnectRedis } from './db/redis.js';

const logger = createLogger({
  service: env.OTEL_SERVICE_NAME,
  level: env.LOG_LEVEL,
  pretty: isDevelopment,
});

async function bootstrap(): Promise<void> {
  await connectMongo(logger);
  const redis = createRedis(logger);

  const app = createApp({ logger, redis });
  const server = createServer(app);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.APP_ENV }, 'api listening');
  });

  /**
   * Graceful shutdown: stop accepting connections, let in-flight requests finish, then close
   * the datastores. A hard exit mid-transaction is how partial writes happen.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close(() => logger.info('http server closed'));
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15_000);
    timeout.unref();

    try {
      await disconnectMongo();
      await disconnectRedis();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A process in an unknown state must not keep serving money endpoints. Log, flush, exit,
  // and let the orchestrator restart it (ERROR_HANDLING.md).
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start api');
  process.exit(1);
});
