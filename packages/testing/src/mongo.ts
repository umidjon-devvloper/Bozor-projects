import mongoose from 'mongoose';
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb';

/**
 * Integration-test infrastructure: a real MongoDB replica set in a container.
 *
 * The replica set is not optional. Every money path in this system is a multi-document
 * transaction and those do not exist on a standalone server (ADR-0001), so a harness that
 * quietly started one would let the transactional tests pass without testing anything.
 *
 * This uses the official `@testcontainers/mongodb` module rather than driving `mongod` and
 * `rs.initiate` by hand. The first version of this file did the latter and was wrong in a way
 * that only appeared on CI: it initiated the replica set advertising the *mapped* host and
 * port, so the member pointed at an address that exists on the test runner and not inside the
 * container. mongod could therefore never reach itself, no primary was ever elected, and all
 * seven suites timed out in `beforeAll`. Getting container-internal and container-external
 * addresses right is exactly the problem the official module exists to solve.
 */

let container: StartedMongoDBContainer | null = null;

const MONGO_IMAGE = process.env.TEST_MONGO_IMAGE ?? 'mongo:7.0';
const DB_NAME = 'bozorlar_test';
/** The name `@testcontainers/mongodb` starts mongod with (`--replSet rs0`). */
const REPLICA_SET = 'rs0';

export async function startMongo(): Promise<void> {
  if (container) return;

  container = await new MongoDBContainer(MONGO_IMAGE).start();

  /**
   * Both parameters are needed, and neither is a workaround.
   *
   * `directConnection=true` because the member is advertised under the container's own
   * address, which does not resolve from the test process; a direct connection tells the
   * driver to talk to the endpoint it was given rather than discovering the topology and
   * following that address. The driver permits this alongside `replicaSet` — its only
   * constraints on `directConnection` are that the URI is not SRV and names exactly one host.
   *
   * `replicaSet=rs0` because `@bozorlar/config` refuses to boot against a URI without it
   * (ADR-0001: transactions require a replica set, and failing at boot beats discovering it
   * when the first commission charge cannot be committed). That guard is correct and is not
   * being circumvented here: this container genuinely is a single-node replica set named rs0,
   * so the URI states a fact rather than satisfying a string check.
   */
  const uri = `${container.getConnectionString()}/${DB_NAME}?replicaSet=${REPLICA_SET}&directConnection=true`;
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB_NAME = DB_NAME;

  await mongoose.connect(uri, { dbName: DB_NAME });
  await assertTransactionsWork();
}

/**
 * Proves, once, that the container really can run a transaction.
 *
 * Without this the harness fails late and obscurely: the first money test to open a session
 * reports something about transaction numbers, and the actual cause — a server that is not a
 * replica set member — is several layers away. Failing here says so in one line.
 */
async function assertTransactionsWork(): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db
        ?.collection('__transaction_probe__')
        .insertOne({ at: new Date() }, { session });
    });
  } catch (error) {
    throw new Error(
      `The test container cannot run transactions, so it is not a usable replica set: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await session.endSession();
    await mongoose.connection.db
      ?.collection('__transaction_probe__')
      .drop()
      .catch(() => undefined);
  }
}

export async function stopMongo(): Promise<void> {
  await mongoose.disconnect();
  await container?.stop();
  container = null;
}

/**
 * Between tests, empty every collection rather than dropping the database: dropping would
 * discard the indexes and `$jsonSchema` validators the migrations installed, and the next test
 * would then pass against a database that does not enforce what production enforces.
 */
export async function clearCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('clearCollections called before startMongo');
  const collections = await db.collections();
  await Promise.all(
    collections
      .filter((collection) => !collection.collectionName.startsWith('system.'))
      .map((collection) => collection.deleteMany({})),
  );
}
