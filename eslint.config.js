import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The client/server boundary is enforced here, not by a package split.
 * `src/web/**` is bundled for the browser: a `node:` builtin or a reach into
 * `src/server/**` must fail lint, not fail at runtime in someone's homelab.
 */
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]

const BOUNDARY_MESSAGE =
  'src/web is bundled for the browser: no Node builtins, no imports from src/server. ' +
  'Share types and pure helpers through src/shared instead.'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/.vitepress/cache/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // TypeScript resolves globals from `types`; core no-undef only yields false positives.
      'no-undef': 'off',
      // Node runs TypeScript in strip-only mode: it erases types, it does not GENERATE code.
      // Parameter properties, enums and namespaces all need generation, so a file using them
      // typechecks, passes tests (vitest transpiles) and then fails at `node src/server/main.ts`.
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
      '@typescript-eslint/no-namespace': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message:
            'enums are not supported by Node type stripping; use a const object with `as const`',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/app/src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({ name, message: BOUNDARY_MESSAGE })),
          patterns: [
            { group: ['node:*'], message: BOUNDARY_MESSAGE },
            { group: ['**/server/**', '../server/*'], message: BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },
)
