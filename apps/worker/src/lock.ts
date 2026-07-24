import type { Redis } from 'ioredis';

/**
 * Redis distributed lock for scheduled jobs.
 *
 * QUEUE_SYSTEM.md rule 1: an unguarded cron fires once per replica. With PM2 cluster mode or
 * several worker pods that means the same sweep runs N times concurrently. The lock TTL is
 * deliberately longer than the job's expected runtime, and the release is guarded by a token
 * so a slow job that has already lost its lock cannot delete a successor's.
 */
export interface HeldLock {
  release(): Promise<void>;
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export async function acquireLock(
  redis: Redis,
  name: string,
  ttlMs: number,
): Promise<HeldLock | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `lock:cron:${name}`;
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired === null) return null;

  return {
    async release(): Promise<void> {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    },
  };
}
