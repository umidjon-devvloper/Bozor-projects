import { fileURLToPath } from 'node:url';

/**
 * RECONSTRUCTED during repository recovery.
 *
 * `permissionCoverage.test.ts` walks `apps/api/src/modules` relative to the working
 * directory, which proves the suite was executed from the repository root. Vitest's `root`
 * option changes module resolution but not `process.cwd()` in the worker, so the worker is
 * moved explicitly here rather than by editing the recovered test.
 */
process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
