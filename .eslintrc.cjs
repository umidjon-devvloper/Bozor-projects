module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  // `tsconfigRootDir` added during repository recovery: lint runs per workspace package
  // through turbo, and without it the relative project path resolves against each
  // package's own directory instead of the repository root.
  parserOptions: {
    // `projectService` replaces the original `project: ['./tsconfig.base.json']` during
    // repository recovery: that file is a settings-only base with no `include`, so it is not
    // a real TypeScript program and type-aware rules were resolving most imports to `any`.
    // The project service uses each workspace package's own tsconfig, which is what `tsc`
    // uses and what the code was written against.
    projectService: true,
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended-type-checked'],
  ignorePatterns: ['dist', 'node_modules', '*.cjs'],

  overrides: [
    {
      /**
       * Tests are held to the same standard as source with three exceptions, each inherent to
       * testing rather than a relaxation of care.
       *
       * `supertest` types a response body as `any`, so every assertion against a real HTTP
       * response trips the unsafe-access rules — the alternative is casting the same shape at
       * two hundred call sites, which adds noise without adding safety.
       *
       * A test asserts on values it has just constructed, so a non-null assertion there is a
       * statement about the fixture rather than an assumption about the world.
       *
       * `require-await` fires on async test bodies that only assert, which is the normal shape
       * of a test that awaits nothing.
       */
      files: ['**/tests/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },
  ],

  rules: {
    /**
     * Express 4 ignores whatever a handler returns, and this codebase depends on that:
     * `rateLimit`, `auth` and `validate` are all async middleware, and `asyncHandler` exists
     * precisely to catch what they reject with. Checking void-returning *arguments* therefore
     * flags the intended pattern at every route registration rather than any defect. Returns
     * in other positions are still checked.
     */
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    /**
     * Controllers are object literals of arrow functions returned by a factory, so they carry
     * no `this` binding and passing them to a router by reference is safe. The rule cannot see
     * that through the factory and fires on every route.
     */
    '@typescript-eslint/unbound-method': 'off',

    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
    'no-restricted-syntax': [
      'error',
      {
        // ADR-0004 / ADR-0025: money and quantity are never plain numbers.
        selector:
          "TSPropertySignature[key.name=/^(amount|price|balance|total|fee|commission|qty|quantity|weight)/] > TSTypeAnnotation > TSNumberKeyword",
        message:
          'Money and quantity fields must not be typed as number. Use Money/Quantity from @bozorlar/money (ADR-0004, ADR-0025).',
      },
    ],
  },
};
