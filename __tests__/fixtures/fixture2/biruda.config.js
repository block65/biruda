/** @const {BirudaConfigFileProperties} */
module.exports = {
  entryPoints: ['src/index.ts'],
  external: ['./src/logger.ts'],
  outfile: 'out/index.js',
  // forceInclude: ['./src/files-n-stuff/01-stuff.ts'],
  // forceBuild: ['./src/files-n-stuff/01-stuff.ts'],
  sourceMapSupport: false,
};
