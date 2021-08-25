/** @const {BirudaConfigFileProperties} */
module.exports = {
  entryPoints: ['src/index.ts'],
  external: ['./src/logger.ts'],
  outfile: 'out/index.js',
  // forceBuild: ['./src/files-n-stuff/01-stuff.ts'],
  sourceMapSupport: false,
};
