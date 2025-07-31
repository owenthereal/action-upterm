module.exports = {
  clearMocks: true,
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'ts'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': 'babel-jest'
  },
  moduleNameMapper: {
    '^csv-parse/sync': '<rootDir>/node_modules/csv-parse/dist/cjs/sync.cjs',
    '^@actions/github$': '<rootDir>/src/__mocks__/@actions/github.js',
    '^@actions/core$': '<rootDir>/src/__mocks__/@actions/core.js'
  },
  collectCoverageFrom: ['src/**/{!(main.ts),}.ts'],
  coveragePathIgnorePatterns: ['lib/', 'node_modules/', '__tests__/'],
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};
