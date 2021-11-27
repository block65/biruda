import { Plugin } from 'esbuild';

const pluginName = 'external-everything';

export function externalEverything(): Plugin {
  return {
    name: pluginName,
    setup(build) {
      let filter = /^[^.\/]|^\.[^.\/]|^\.\.[^\/]/; // Must not start with "/" or "./" or "../"
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}
