import * as esbuild from 'esbuild';
import { statSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import pkgUp from 'pkg-up';
import { dir } from 'tmp-promise';
import type { PackageJson, TsConfigJson } from 'type-fest';
import { pathToFileURL, URL } from 'url';
import { logger } from '../logger.js';
import type { BirudaBuildOptions } from '../types.js';
import { loadJson, loadPackageJson } from '../utils.js';
import { externalsRegExpPlugin } from './esbuild-plugin-external-wildcard.js';

export async function build(options: BirudaBuildOptions): Promise<{
  outputFiles: [entryPointName: string, fileName: string][];
  outputDir: string;
  tsConfigJson: TsConfigJson;
  packageJson: PackageJson;
  cleanup: () => Promise<void>;
}> {
  const { entryPoints } = options;

  const entryPointPaths = Object.values(entryPoints);

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

  const packageJsonUrl = pathToFileURL(packageJsonPath);

  const packageJson = await loadPackageJson(packageJsonUrl);

  const tsConfigJson = await loadJson<TsConfigJson>(
    new URL('tsconfig.json', packageJsonUrl),
  );

  // we need to perform the process inside this directory
  // so we create a tmp file before we move the resulting bundle
  // back out to where the user wanted
  const { path: outputDir, cleanup } = await dir({
    tmpdir: dirname(packageJsonPath),
    template: '.tmp-biruda-XXXXXX',
    unsafeCleanup: true,
  });

  process.on('beforeExit', () =>
    cleanup().catch((err) => logger.warn({ err }, err.message)),
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
    entryPoints: entryPointPaths,
    outdir: outputDir,
    bundle: true,
    minify: options.minify,
    treeShaking: true,
    color: true,
    target: tsConfigJson.compilerOptions?.target,
    sourcemap: 'external',
    format: 'esm' || options.sourceType,
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
    // metafile: '/tmp/meta.json',
    // absWorkingDir: dirname(entryPoint),
    // errorLimit: 1,
  };

  logger.info(
    { entryPointPaths, finalEsBuildOptions },
    'Building entryPoints...',
  );

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

  const outputFiles = buildResult.outputFiles.map((outputFile): [
    entryPointName: string,
    fileName: string,
  ] => {
    const [outputFilePathBasename, ...exts] = basename(outputFile.path).split(
      /\./,
    );

    // find the entrypoint that matches this output file
    const [entryPointName /* , entryPointFileForOutput */] =
      Object.entries(entryPoints).find(([, entryPointFile]) => {
        return (
          basename(entryPointFile).replace(/\.[t|j]s$/, '') ===
          outputFilePathBasename
        );
      }) || [];

    if (!entryPointName) {
      logger.warn({ entryPoints, outputFilePathBasename, exts });
      throw new Error('Cant find matching entry point for build output ');
    }

    const fileName = `${join(outputDir, entryPointName)}.${exts.join('.')}`;

    writeFileSync(fileName, outputFile.contents, {
      encoding: 'utf-8',
    });

    return [entryPointName, fileName];
  });

  logger.info(`Build completed. Output is in ${outputDir}`);

  return {
    outputFiles: outputFiles.filter(
      ([, fileName]) => !fileName.endsWith('.map'),
    ), // : [...outputFiles, ...secondOutputFiles],
    outputDir,
    cleanup,
    packageJson,
    tsConfigJson,
  };
}
