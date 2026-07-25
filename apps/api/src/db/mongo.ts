import mongoose from 'mongoose';
import { env } from '@bozorlar/config';
import type { Logger } from '@bozorlar/logger';

export async function connectMongo(logger: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', 'throw');
  // Strips keys beginning with $ or containing dots from filters. Defence in depth against
  // NoSQL injection alongside Zod validation at the boundary (SECURITY.md).
  mongoose.set('sanitizeFilter', true);

  mongoose.connection.on('connected', () => logger.info('mongodb connected'));
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  mongoose.connection.on('error', (error) => logger.error({ err: error }, 'mongodb error'));

  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.MONGODB_DB_NAME,
    maxPoolSize: 100,
    minPoolSize: 5,
    maxIdleTimeMS: 60_000,
    // A short queue timeout turns pool exhaustion into a fast, clear error instead of a
    // cascade of hanging requests (DATABASE.md 6.4).
    waitQueueTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    writeConcern: { w: 'majority', journal: true },
  });

  await assertReplicaSet(logger);
  return mongoose;
}

/**
 * ADR-0001 makes a replica set non-negotiable: without one, session.withTransaction throws
 * at runtime, and every money path in this system is transactional. Failing here, loudly,
 * at boot is far cheaper than failing on the first commission charge.
 */
async function assertReplicaSet(logger: Logger): Promise<void> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('Mongo connection has no database handle');
  const info = (await admin.command({ hello: 1 })) as { setName?: string };
  if (!info.setName) {
    throw new Error(
      'MongoDB is not running as a replica set. Transactions are unavailable and the ' +
        'commission ledger cannot be written safely (ADR-0001). Start the stack with ' +
        '`pnpm infra:up`, which initialises rs0.',
    );
  }
  logger.info({ replicaSet: info.setName }, 'mongodb replica set verified');
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.connection.close(false);
}

export function mongoHealthy(): boolean {
  // 1 is `connected`. Compared through the driver's own enum so the constant is named rather
  // than a magic number, and so the comparison is type-safe.
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
