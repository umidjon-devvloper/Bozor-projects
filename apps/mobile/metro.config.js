const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro in a pnpm workspace.
 *
 * Two settings, both required, and neither is optional folklore. `watchFolders` points at the
 * repository root so edits to `packages/*` reach the bundler at all — without it Metro watches
 * only this app and a change to the shared session provider appears to do nothing.
 *
 * `nodeModulesPaths` plus `disableHierarchicalLookup` is the pnpm part. pnpm stores real
 * packages in a content-addressed store and links them, so Metro's default upward search finds
 * symlinks it will not follow and resolves the same module twice — which in React's case means
 * two copies of React and a runtime error about invalid hooks that points nowhere near the
 * cause.
 */
const workspaceRoot = path.resolve(__dirname, '../..');
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
