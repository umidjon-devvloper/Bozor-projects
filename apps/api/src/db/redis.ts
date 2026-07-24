import { Redis } from 'ioredis';
import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';

let client: Redis | null = null;

export function createRedis(logger: Logger): Redis {
  if (client) return client;
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('connect', () => logger.info('redis connected'));
  client.on('error', (error) => logger.error({ err: error }, 'redis error'));
  return client;
}

export function getRedis(): Redis {
  if (!client) throw new Error('Redis has not been initialised');
  return client;
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
