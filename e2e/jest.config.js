module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/e2e/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|js)$': 'ts-jest'
  },
  // Transform ESM modules from @octokit
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|before-after-hook|universal-user-agent)/)'
  ],
  // Longer timeouts for e2e tests
  testTimeout: 300000, // 5 minutes
  verbose: true
};
