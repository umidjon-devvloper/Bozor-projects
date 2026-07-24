import mongoose from 'mongoose';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * Integration-test infrastructure: a real MongoDB replica set in a container.
 *
 * RECONSTRUCTED during repository recovery — the original `@bozorlar/testing` package was not
 * in the uploaded artifacts. The three exported functions and their signatures are proved by
 * the seven integration suites that call them; the replica set is not optional, because every
 * money path uses a multi-document transaction and those do not exist on a standalone server
 * (ADR-0001). A single-node replica set is used rather than three, because the transaction
 * API is what the tests need, not failover behaviour.
 */

let container: StartedTestContainer | null = null;

const MONGO_IMAGE = process.env.TEST_MONGO_IMAGE ?? 'mongo:7.0';
const REPLICA_SET = 'rs0';

export async function startMongo(): Promise<void> {
  if (container) return;

  container = await new GenericContainer(MONGO_IMAGE)
    .withExposedPorts(27017)
    .withCommand(['mongod', '--replSet', REPLICA_SET, '--bind_ip_all'])
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/i))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(27017);

  // The replica set must be initiated with the host and port the client will actually dial:
  // a member advertised as the container's internal address is unreachable from the test
  // process, and the driver would follow the advertised address and hang.
  await container.exec([
    'mongosh',
    '--quiet',
    '--eval',
    `rs.initiate({_id:'${REPLICA_SET}',members:[{_id:0,host:'${host}:${port}'}]})`,
  ]);

  const uri = `mongodb://${host}:${port}/bozorlar_test?replicaSet=${REPLICA_SET}&directConnection=true`;
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB_NAME = 'bozorlar_test';

  await waitForPrimary(uri);
  await mongoose.connect(uri, { dbName: 'bozorlar_test' });
}

async function waitForPrimary(uri: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const probe = await mongoose.createConnection(uri, { dbName: 'admin' }).asPromise();
      const status = await probe.db?.admin().command({ hello: 1 });
      await probe.close();
      if (status?.isWritablePrimary === true) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Replica set did not elect a primary in time: ${String(lastError)}`);
}

export async function stopMongo(): Promise<void> {
  await mongoose.disconnect();
  await container?.stop();
  container = null;
}

/**
 * Between tests, empty every collection rather than dropping the database: dropping would
 * discard the indexes and `$jsonSchema` validators the migrations installed, and the next
 * test would then pass against a database that does not enforce what production enforces.
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
