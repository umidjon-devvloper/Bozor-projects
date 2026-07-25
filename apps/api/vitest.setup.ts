import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * RECONSTRUCTED during repository recovery.
 *
 * `permissionCoverage.test.ts` walks `apps/api/src/modules` relative to the working
 * directory, which proves the suite was executed from the repository root. Vitest's `root`
 * option changes module resolution but not `process.cwd()` in the worker, so the worker is
 * moved explicitly here rather than by editing the recovered test.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
process.chdir(repoRoot);

/**
 * A throwaway signing key, generated in-process.
 *
 * `getJwtKeys()` reads the key files and calls `process.exit(1)` when they are missing, which
 * is right for a server — an API that boots without a signing key is worse than one that
 * refuses to boot — but it means every integration suite dies at `createApp()` unless the keys
 * exist first. The keys are gitignored and must stay that way, so CI has none.
 *
 * Generated with `node:crypto` rather than by shelling out to `openssl`, so the suite has one
 * fewer thing that has to be installed on the machine running it. The key never leaves the
 * test machine and is regenerated whenever it is absent; it is not a secret and must never
 * become one that is committed.
 */
const keyDir = resolve(repoRoot, 'keys');
const privatePath = resolve(keyDir, 'jwt-private.pem');
const publicPath = resolve(keyDir, 'jwt-public.pem');

if (!existsSync(privatePath) || !existsSync(publicPath)) {
  mkdirSync(keyDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });
}
