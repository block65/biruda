import { Plugin } from 'esbuild';

const pluginName = 'externals-regexp';

export function externalsRegExpPlugin({
  externals,
}: {
  externals: RegExp[];
}): Plugin {
  return {
    name: pluginName,
    setup(build) {
      externals.forEach((filter) => {
        build.onResolve({ filter }, (args) => ({ ...args, external: true }));
      });
    },
  };
}
