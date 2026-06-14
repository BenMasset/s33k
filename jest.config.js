const nextJest = require('next/jest');
require('dotenv').config({ path: './.env.local' });

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
});

// Add any custom config to be passed to Jest
/** @type {import('jest').Config} */
const customJestConfig = {
  // Add more setup options before each test is run
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  // if using TypeScript with a baseUrl set to the root directory then you need the below for alias' to work
  moduleDirectories: ['node_modules', '<rootDir>/'],
  testEnvironment: 'jest-environment-jsdom',
};

// MSW 2.x and parts of its dependency chain (notably until-async, which is
// "type": "module") ship untranspiled ESM. next/jest injects a leading
// "/node_modules/" into transformIgnorePatterns, and because the list is OR-ed
// that broad pattern still excludes those ESM packages from transformation. So we
// resolve the config first and then REPLACE transformIgnorePatterns with a
// negative-lookahead allowlist so Jest transpiles only the MSW ESM chain.
const esmPackages = [
  'msw',
  '@mswjs',
  'until-async',
  '@bundled-es-modules',
  'headers-polyfill',
  'outvariant',
  'strict-event-emitter',
  'is-node-process',
  'graphql',
];

module.exports = async () => {
  // createJestConfig returns an async function so next/jest can load next.config.js.
  const config = await createJestConfig(customJestConfig)();
  config.transformIgnorePatterns = [
    `/node_modules/(?!.pnpm/)(?!(${esmPackages.join('|')})/)`,
    '^.+\\.module\\.(css|sass|scss)$',
  ];
  return config;
};
