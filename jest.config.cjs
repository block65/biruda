module.exports = {
  preset: 'ts-jest/presets/default-esm',
  globals: {
    'ts-jest': {
      useESM: true,
    },
  },
  moduleNameMapper: {
    '^(\\..*)\\.jsx?$': '$1',
  },
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  verbose: true,
};
