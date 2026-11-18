import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'dist-e2e', 'dist-desktop', 'dist-desktop-e2e', 'release', 'node_modules', 'playwright-report', 'test-results', 'tests/.tmp', 'tests/fixtures'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'desktop/renderer/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Playwright's `use` fixture callback is not a React hook; tests print diagnostics on purpose.
    files: ['tests/e2e/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off', 'no-console': 'off' },
  },
  {
    // The desktop suite reaches the app's test hooks through `globalThis` (untyped on purpose) and uses Playwright's `use`.
    files: ['tests/e2e-desktop/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off', 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off', 'no-empty-pattern': 'off' },
  },
  {
    files: ['desktop/main/**/*.ts', 'desktop/preload/**/*.ts', 'desktop/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'tests/e2e/server.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
