module.exports = {
  root: true,
  extends: '@block65',
  env: {
    node: true,
  },
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: [
      './tsconfig.json',
    ],
  },
};
