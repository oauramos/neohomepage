import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Enforces the client/server boundary: src/web and src/shared are bundled for the browser, so they
 * may not value-import Node builtins or src/server. Type-only imports vanish at compile time and
 * are allowed. Tests run in Node and are exempt.
 */
// prettier-ignore
const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]

function boundaryRule(message) {
  return [
    'error',
    {
      paths: NODE_BUILTINS.map((name) => ({ name, message, allowTypeImports: true })),
      patterns: [
        { group: ['node:*'], message, allowTypeImports: true },
        { group: ['**/server/**'], message, allowTypeImports: true },
      ],
    },
  ]
}

const WEB_MESSAGE =
  'src/web is bundled for the browser: no Node builtins and no value imports from src/server. ' +
  'Share types and pure helpers through src/shared instead.'

const SHARED_MESSAGE =
  'src/shared is bundled into the browser through src/web: type-only imports from src/server are ' +
  'fine because they vanish at runtime, but a value import would pull server code into the bundle.'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/.vitepress/cache/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JS is not covered by the `no-undef: off` below. `window` is real here: a
    // `page.evaluate()` body runs inside the page.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      // TypeScript resolves globals from `types`; core no-undef only yields false positives.
      'no-undef': 'off',
      // Node type stripping erases types but generates no code: parameter properties, enums and
      // namespaces pass typecheck and vitest, then fail at `node src/server/main.ts`.
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
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/app/src/shared/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-restricted-imports': boundaryRule(SHARED_MESSAGE) },
  },
  {
    files: ['packages/app/src/web/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-restricted-imports': boundaryRule(WEB_MESSAGE) },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.smoke.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },
)
