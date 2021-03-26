import type { PackageJson, TsConfigJson } from 'type-fest';
import * as esbuild from 'esbuild';
import { statSync, writeFileSync } from 'fs';
import { dir } from 'tmp-promise';
import pkgUp from 'pkg-up';
import { basename, dirname, join, resolve } from 'path';
import { logger } from '../logger';
import { BirudaBuildOptions } from '../types';
import { externalsRegExpPlugin } from './esbuild-plugin-external-wildcard';

export async function build(
  options: BirudaBuildOptions,
): Promise<{
  outputFiles: Record<string, string>;
  outputDir: string;
  tsConfigJson: TsConfigJson;
  packageJson: PackageJson;
  cleanup: () => Promise<void>;
}> {
  const { entryPoints } = options;

  const entryPointPaths = Object.values(entryPoints);
  const entryPointNames = Object.keys(entryPoints);

  const [firstEntryPoint] = entryPointPaths;

  const firstEntryPointStat = statSync(firstEntryPoint);
  if (!firstEntryPointStat.isFile()) {
    throw new Error(`Invalid entrypoint ${entryPointPaths}`);
  }

  const packageJsonPath = await pkgUp({
    cwd: dirname(firstEntryPoint),
  });

  if (!packageJsonPath) {
    throw new Error('Cant find a package.json');
  }

  // eslint-disable-next-line global-require,import/no-dynamic-require
  const packageJson: PackageJson = require(packageJsonPath);

  // eslint-disable-next-line global-require,import/no-dynamic-require
  const tsConfigJson: TsConfigJson = require(resolve(
    dirname(packageJsonPath),
    'tsconfig.json',
  ));

  // we need to perform the process inside this directory
  // so we create a tmp file before we move the resulting bundle
  // back out to where the user wanted
  const { path: outputDir, cleanup } = await dir({
    tmpdir: dirname(packageJsonPath),
    template: '.tmp-biruda-XXXXXX',
    unsafeCleanup: true,
  });

  process.on('beforeExit', () =>
    cleanup().catch((err) => console.warn(err.message)),
  );

  const externals: (string | RegExp)[] = [
    ...(options.ignorePackages || []),
    ...(options.externals || []),
    // really doesnt play nice with biruda (uses mjs) needs investigation, it might be fixable
    ...['decimal.js'],
  ];

  logger.trace({ externals }, 'Resolved externals');

  // const esBuildOutputFilePath = resolve(tmpDir, 'index.js');

  const finalEsBuildOptions: esbuild.BuildOptions = {
    platform: options.platform === 'browser' ? 'browser' : 'node',
    logLevel: options.verbose ? 'info' : 'error',
    external: externals.filter((ext): ext is string => typeof ext === 'string'),
    entryPoints: entryPointPaths, // [maybeMakeAbsolute(entryPoint, baseDir)],
    // outfile: esBuildOutputFilePath,
    outdir: outputDir,
    // write: false,
    // metafile: '/tmp/meta.json',
    // absWorkingDir: dirname(entryPoint),
    bundle: true,
    minify: false,
    color: true,
    target: tsConfigJson.compilerOptions?.target,
    sourcemap: true, // 'external',
    // errorLimit: 1,
    write: false,
    define: {
      NODE_ENV: 'production',
    },
    plugins: [
      externalsRegExpPlugin({
        externals: externals.filter(
          (ext): ext is RegExp => ext instanceof RegExp,
        ),
      }),
    ],
  };

  logger.info('Building entryPoints %s ...', entryPointPaths);

  const buildResult = await esbuild.build(finalEsBuildOptions);

  if (buildResult.warnings.length > 0) {
    logger.warn('Build warnings: %d', buildResult.warnings.length);

    buildResult.warnings.forEach((warn) => {
      logger.trace(warn, `Warning: ${warn.text}`);
    });
  }

  if (!buildResult.outputFiles) {
    throw new Error('Missing outputFiles from build result');
  }

  const outputFiles = Object.fromEntries(
    buildResult.outputFiles.map((outputFile) => {
      const [outputFilePathBasename, ...exts] = basename(outputFile.path).split(
        /\./,
      );

      // find the entrypoint that matches this output file
      const [entryPointName, entryPointFileForOutput] =
        Object.entries(entryPoints).find(([, entryPointFile]) => {
          return basename(entryPointFile, '.js') === outputFilePathBasename;
        }) || [];

      if (!entryPointName) {
        throw new Error('Cant find matching entry point for build output');
      }

      const fileName = `${join(outputDir, entryPointName)}.${exts.join('.')}`;

      writeFileSync(fileName, outputFile.contents, {
        encoding: 'utf8',
      });

      return [entryPointName, fileName];
    }),
  );

  // const outputFiles = Object.fromEntries(
  //   Object.entries(options.entryPoints).map(([name, file]) => {
  //     return [name, basename(file)];
  //   }),
  // );

  logger.info(`Build completed. Output is in ${outputDir}`);

  return {
    outputFiles,
    outputDir,
    cleanup,
    packageJson,
    tsConfigJson,
  };

  // .catch((err) => logger.error(err));
}
