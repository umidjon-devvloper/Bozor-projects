#!/usr/bin/env node
/**
 * Generates the RSA key pair the API signs access tokens with.
 *
 * `package.json` has referenced this script since the repository was recovered and the file
 * itself was missing, which meant the documented way to produce the keys did not exist and a
 * first boot failed with an ENOENT nobody could act on.
 *
 * `node:crypto` rather than shelling out to `openssl`: one fewer thing that has to be installed
 * on whatever machine is bringing the stack up, and identical output.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const keyDir = resolve(here, '..', 'keys');
const privatePath = resolve(keyDir, 'jwt-private.pem');
const publicPath = resolve(keyDir, 'jwt-public.pem');

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Keys already exist at ${keyDir}. Pass --force to replace them.`);
  console.log('Replacing them signs out every user, because their tokens no longer verify.');
  process.exit(0);
}

mkdirSync(keyDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// 0600: readable by the owner alone. A signing key with wider permissions is a signing key
// anybody on the machine can mint tokens with.
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });

console.log(`Wrote ${privatePath}`);
console.log(`Wrote ${publicPath}`);
console.log('These are gitignored and must stay that way.');
