import type { Config } from 'jest'

const config: Config = {
    preset: 'ts-jest',
    rootDir: "./",
    testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
    testEnvironment: 'node',
    detectOpenHandles: true,
    
};

export default config;