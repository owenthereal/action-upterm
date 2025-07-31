module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint', 'prettier', 'jest'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  rules: {
    '@typescript-eslint/no-unused-vars': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-non-null-assertion': 'error',
    'prettier/prettier': 'error'
  },
  overrides: [
    {
      files: ['**/*.test.ts'],
      extends: ['plugin:jest/recommended'],
      env: {
        jest: true
      }
    },
    {
      files: ['*.js'],
      env: {
        node: true
      },
      rules: {
        '@typescript-eslint/no-var-requires': 'off'
      }
    }
  ],
  ignorePatterns: ['lib/', 'node_modules/', 'coverage/', '*.config.js', '__mocks__/']
};
