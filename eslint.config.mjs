import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'src/main/db/migrations/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-globals': [
        'error',
        { name: 'alert', message: 'Use the dialog service.' },
        { name: 'confirm', message: 'Use the dialog service.' },
        { name: 'prompt', message: 'Use the dialog service.' }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactRefresh.configs.vite
  },
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: false, project: './tsconfig.e2e.json' }
    }
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.eval.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-misused-promises': 'off'
    }
  },
  {
    files: ['*.config.{ts,mjs,js}', 'drizzle.config.ts'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked
  },
  prettier
)
