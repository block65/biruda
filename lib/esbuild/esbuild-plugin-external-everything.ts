import { Plugin } from 'esbuild';

const pluginName = 'external-everything';

export function externalEverything(): Plugin {
  return {
    name: pluginName,
    setup(build) {
      const filter = /^[^.\/]|^\.[^.\/]|^\.\.[^\/]/; // Must not start with "/" or "./" or "../"
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}
