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
  rules: {
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
