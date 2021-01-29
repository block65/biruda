module.exports = {
  root: true,
  extends: '@block65',
  env: {
    node: true,
  },
  parserOptions: {
    project: ['./tsconfig.json', './__tests__/tsconfig.json'],
  },
};
