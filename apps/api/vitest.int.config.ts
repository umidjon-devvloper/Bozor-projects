import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * RECONSTRUCTED during repository recovery — no vitest config survived in the uploaded
 * artifacts, but two behaviours in the suite prove one existed: the permission-coverage test
 * reads source files relative to the repository root, and every suite that transitively
 * imports `@bozorlar/config` needs a complete environment, because the config package
 * validates the whole environment at import time and exits the process when it is incomplete.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const testEnv = parseDotenv(readFileSync(new URL('.env.test', import.meta.url)));

export default defineConfig({
  root: repoRoot,
  test: {
    include: ['apps/api/tests/integration/**/*.test.ts'],
    setupFiles: [fileURLToPath(new URL('vitest.setup.ts', import.meta.url))],
    environment: 'node',
    env: testEnv,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
