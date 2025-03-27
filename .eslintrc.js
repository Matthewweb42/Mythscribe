module.exports = {
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    extends: [
      'react-app',
      'react-app/jest',
      'plugin:@typescript-eslint/recommended'
    ],
    rules: {
      // Custom ESLint rules
      '@typescript-eslint/explicit-function-return-type': 'warn'
    }
  };