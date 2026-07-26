/** Enforces the module boundaries from ADR-0011. A violation is a CI failure, not a review comment. */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-app-imports',
      comment: 'apps/* must never import from another app (ADR-0011 rule 5)',
      severity: 'error',
      from: {
        path: '^apps/([^/]+)/',
        /**
         * Two exclusions, both because the rule is about deployables coupling at runtime.
         *
         * An integration test that drives the worker's sweeper against the API's database is
         * doing the one thing an integration test exists for: proving two deployables agree.
         * Forbidding it would mean the only way to test the boundary is to not test it.
         *
         * A Tailwind config extending another app's is build configuration. It produces no
         * import in anything that ships, and the alternative — a fourth package holding twelve
         * colour constants — is ceremony that makes the palette harder to find, not safer.
         */
        pathNot: '(^apps/[^/]+/tests/|tailwind\\.config\\.ts$)',
      },
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
      to: {
        path: '\\.model\\.ts$',
        // A type import is not the model leaving anywhere: it compiles away entirely and
        // carries no query methods. What the rule is protecting against is a service holding a
        // Mongoose Model and querying through it, and that is a value import. Shapes declared
        // beside a schema are the natural place for them to live.
        dependencyTypesNot: ['type-only'],
      },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      comment: 'A module nothing imports is usually a leftover',
      severity: 'warn',
      from: {
        orphan: true,
        /**
         * Four kinds of file are orphans by design and always will be.
         *
         * Migrations are loaded by migrate-mongo from disk. Test files are entered by vitest.
         * Build configs are read by their own tool. Type declarations declare rather than
         * export. Reporting all of them buries the one case this rule is for: a module left
         * behind after the thing that used it was deleted.
         */
        pathNot: [
          '\\.d\\.ts$',
          '^apps/api/migrations/',
          '\\.test\\.ts$',
          '(tailwind|postcss|next|metro|vitest[^/]*)\\.config\\.(ts|js|mjs)$',
          '^apps/[^/]+/vitest\\.setup\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output is not source and has no boundaries to respect. Without this, Next's
    // compiled chunks flood the report with orphan warnings and bury anything real.
    exclude: { path: '(^|/)(\\.next|dist|coverage)(/|$)' },
    /**
     * One tsconfig for the whole repository, which is a known blind spot.
     *
     * `tsconfig.base.json` declares no `paths`, so the `@/*` alias the four frontend apps use
     * is unresolvable here — dependency-cruiser sees those imports as unfollowable and reports
     * the targets as orphans. Three files below are flagged for that reason and are not
     * actually orphaned.
     *
     * The consequence is larger than the warnings: boundary rules are not being enforced
     * across aliased imports inside apps/web, apps/seller, apps/admin and apps/mobile. Fixing
     * it means running the cruiser per workspace with each app's own tsconfig, which is a
     * change to how the check is invoked rather than to this file.
     */
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
  },
};
