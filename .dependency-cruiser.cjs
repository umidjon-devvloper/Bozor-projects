/** Enforces the module boundaries from ADR-0011. A violation is a CI failure, not a review comment. */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-app-imports',
      comment: 'apps/* must never import from another app (ADR-0011 rule 5)',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'utils-must-stay-pure',
      comment: 'packages/utils and packages/money must have no I/O dependencies',
      severity: 'error',
      from: { path: '^packages/(money|types)/' },
      to: { dependencyTypes: ['npm'], pathNot: 'zod' },
    },
    {
      name: 'no-deep-module-imports',
      comment: 'A module may only import another module through its public index.ts (ADR-0011 rule 1)',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/([^/]+)/.+',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'models-stay-in-repositories',
      comment: 'Mongoose models must never leave the repository layer (ADR-0011 rule 2)',
      severity: 'error',
      from: { path: '(controller|routes|service)\\.ts$' },
      to: { path: '\\.model\\.ts$' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn', from: { orphan: true, pathNot: '\\.d\\.ts$' }, to: {} },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output is not source and has no boundaries to respect. Without this, Next's
    // compiled chunks flood the report with orphan warnings and bury anything real.
    exclude: { path: '(^|/)(\\.next|dist|coverage)(/|$)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
