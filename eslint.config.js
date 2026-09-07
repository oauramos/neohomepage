import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The client/server boundary is enforced here, not by a package split.
 *
 * `src/web` is bundled for the browser and `src/shared` is pulled in with it, so neither may take
 * a VALUE import from a Node builtin or from `src/server` — that is what would put server code in
 * the bundle. Type-only imports are allowed everywhere, because they vanish at compile time and
 * describing a server-owned shape is exactly what `src/shared` is for.
 *
 * Tests are exempt: they run in Node and are never bundled, so a test asserting that the server
 * and the browser agree has to be able to import both.
 */
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
    // Plain JS tooling scripts. They are not TypeScript, so the `no-undef: off` below does not
    // reach them and every Node global reads as undefined. Declared by hand rather than pulling
    // in `globals` for five names — including `window`, which really is a browser global here:
    // the body of a `page.evaluate()` is serialised and run inside the page, where it exists.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
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
