import type { Config } from 'jest'


const config: Config = {
  preset: 'ts-jest',
  globalSetup: './tests/e2e/setup.js',
  globalTeardown: './tests/e2e/teardown.js',
  testMatch: ['**/tests/e2e/**/*.test.ts'],
};

export default config;
