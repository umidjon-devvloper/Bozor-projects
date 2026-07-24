import type { Redis } from 'ioredis';
import type { Logger } from '@bozorlar/logger';

/**
 * Redis cache with single-flight and tag-based invalidation (CACHING.md).
 *
 * Two properties matter here. First, a cold key under load must not send every concurrent
 * request to MongoDB — one caller wins a short lock and the rest wait for its result.
 * Second, every key carries tags so that a shop update can purge the shop's own entry and
 * every list that embedded it, without maintaining an invalidation map by hand.
 */
export interface CacheOptions {
  ttlSeconds: number;
  tags?: string[];
}

const LOCK_TTL_MS = 5_000;
const LOCK_WAIT_MS = 3_000;
const LOCK_POLL_MS = 40;

export function createCache(redis: Redis, logger: Logger, namespace: string) {
  const key = (suffix: string) => `cache:${namespace}:${suffix}`;
  const tagKey = (tag: string) => `cache:tag:${tag}`;
  const lockKey = (suffix: string) => `lock:${namespace}:${suffix}`;

  async function readThrough<T>(
    suffix: string,
    options: CacheOptions,
    load: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = key(suffix);

    try {
      const hit = await redis.get(cacheKey);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (error) {
      // A cache read failure must degrade to a database read, never to an error response.
      logger.warn({ err: error, cacheKey }, 'cache read failed; falling through');
      return load();
    }

    const lock = lockKey(suffix);
    const acquired = await redis.set(lock, '1', 'PX', LOCK_TTL_MS, 'NX');

    if (acquired === null) {
      // Someone else is loading. Wait briefly for their result rather than duplicating the
      // query; if they are slow, load independently rather than holding the request open.
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        const hit = await redis.get(cacheKey);
        if (hit !== null) return JSON.parse(hit) as T;
      }
      return load();
    }

    try {
      const value = await load();
      const pipeline = redis.pipeline();
      pipeline.set(cacheKey, JSON.stringify(value), 'EX', options.ttlSeconds);
      for (const tag of options.tags ?? []) {
        pipeline.sadd(tagKey(tag), cacheKey);
        // Tag sets outlive their members slightly so a purge cannot miss a fresh entry.
        pipeline.expire(tagKey(tag), options.ttlSeconds * 2);
      }
      await pipeline.exec();
      return value;
    } finally {
      await redis.del(lock);
    }
  }

  async function invalidateTags(...tags: string[]): Promise<number> {
    if (tags.length === 0) return 0;
    let removed = 0;
    for (const tag of tags) {
      const members = await redis.smembers(tagKey(tag));
      if (members.length > 0) {
        removed += await redis.del(...members);
      }
      await redis.del(tagKey(tag));
    }
    return removed;
  }

  async function invalidateKey(suffix: string): Promise<void> {
    await redis.del(key(suffix));
  }

  return { readThrough, invalidateTags, invalidateKey };
}

export type Cache = ReturnType<typeof createCache>;

export const CacheTag = {
  regions: () => 'geo:regions',
  districts: (regionId: string) => `geo:districts:${regionId}`,
  market: (marketId: string) => `geo:market:${marketId}`,
  marketList: () => 'geo:markets',
  shop: (shopId: string) => `geo:shop:${shopId}`,
  shopsOfMarket: (marketId: string) => `geo:shops:market:${marketId}`,
  categories: () => 'catalog:categories',
  units: () => 'catalog:units',
  product: (productId: string) => `catalog:product:${productId}`,
  productsOfShop: (shopId: string) => `catalog:products:shop:${shopId}`,
} as const;
