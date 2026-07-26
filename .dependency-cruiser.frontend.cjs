/**
 * Boundary rules for a single frontend app, run from inside that app.
 *
 * A separate config because `tsConfig` takes one file, and each Next application declares its
 * own `@/*` alias in its own tsconfig. Running the shared config from the repository root left
 * every aliased import unresolvable, which meant no rule was enforced inside the four frontend
 * apps at all — they looked clean because nothing was being checked.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-app-imports',
      comment: 'An app must not reach into another app (ADR-0011 rule 5)',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^\\.\\./[^/]+/src/' },
    },
    /**
     * A rule that belongs here and cannot be written yet: a `'use client'` module must not
     * import server-only code such as `next/headers`. dependency-cruiser matches paths, not
     * file contents, so it cannot tell a client component from a server one — and a rule that
     * flagged every use would fire on the server components that are supposed to use it.
     * Left as a note rather than as a check that cries wolf.
     */
    {
      name: 'no-direct-fetch',
      comment: 'Talk to the API through @bozorlar/api-client, not raw fetch wrappers',
      severity: 'warn',
      from: { path: '^src/(?!lib/)' },
      to: { path: 'node-fetch|axios' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(\\.next|dist|coverage)(/|$)' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
