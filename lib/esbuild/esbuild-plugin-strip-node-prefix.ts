import { Plugin } from 'esbuild';

const pluginName = 'strip-node-prefix';

export function stripNodePrefixPlugin(): Plugin {
  return {
    name: pluginName,
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path.slice('node:'.length),
        external: true,
      }));
    },
  };
}
