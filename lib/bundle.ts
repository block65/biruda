import { dirname, resolve } from 'path';
import { logger } from './logger';
import { traceFiles } from './deps';
import { archiveFiles } from './archive';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
  build,
} from './build';
import {
  getDependencyPathsFromModule,
  maybeMakeAbsolute,
  resolveModulePath,
  serialPromiseMapAccum,
} from './utils';

export async function cliBundle(cliArguments: BirudaCliArguments) {
  const configFileProps: BirudaConfigFileProperties = cliArguments.config
    ? // eslint-disable-next-line global-require,import/no-dynamic-require
      require(resolve(
        cliArguments.config ? dirname(cliArguments.config) : process.cwd(),
        cliArguments.config,
      ))
    : {};

  const outDir = cliArguments.output || configFileProps.outDir;

  if (!outDir) {
    throw new TypeError('No outDir');
  }

  const resolvedConfig = {
    entryPoints: cliArguments.entrypoint || configFileProps.entryPoints,
    verbose: cliArguments.verbose || configFileProps.verbose,
    sourceMapSupport: true,
    ...configFileProps,
  };

  const { entryPoints = [], forceInclude = [], ...restConfig } = resolvedConfig;

  if (restConfig.verbose) {
    logger.level = 'trace';
  }

  if (entryPoints.length === 0) {
    throw new TypeError('No entryPoints');
  }

  if (entryPoints.length > 1) {
    throw new TypeError('Only 1 entryPoint supported so far');
  }

  // const baseDir = process.cwd();
  // const baseDir = dirname(entryPoint);

  await serialPromiseMapAccum(entryPoints, async (entryPoint) => {
    const absoluteEntryPoint = maybeMakeAbsolute(entryPoint, process.cwd());

    const options: Omit<BirudaBuildOptions, 'entryPoints'> = {
      platform: 'node',
      entryPoint: absoluteEntryPoint,
      ...restConfig,
      outDir,
      externals: [
        ...(restConfig.sourceMapSupport ? ['source-map-support'] : []),
        ...(restConfig.externals || []),
      ],
    };

    const { tmpFile: pkgFile, tmpDir: pkgDir, cleanup } = await build(options);

    logger.info(
      `Tracing remaining dependencies. wd: %s`,
      dirname(absoluteEntryPoint),
    );

    const { files, base } = await traceFiles(pkgFile, {
      originalEntryPoint: absoluteEntryPoint,
      ignorePackages: resolvedConfig.ignorePackages,
    });

    // const dependencies = await traceFileDependencies(pkgFile, {
    //   workingDirectory: dirname(absoluteEntryPoint),
    //   ignorePackages: resolvedConfig.ignorePackages,
    // });

    // if (
    //   resolvedConfig.sourceMapSupport &&
    //   !dependencies.has('source-map-support')
    // ) {
    //   const smpPkgJsonPath = pkgUp.sync({
    //     cwd: require.resolve('source-map-support', {
    //       paths: [dirname(absoluteEntryPoint)],
    //     }),
    //   });

    //   if (!smpPkgJsonPath) {
    //     throw new Error('Unable to resolve source-map-support');
    //   }

    //   dependencies.set('source-map-support@*', {
    //     name: 'source-map-support',
    //     version: '*',
    //     path: dirname(smpPkgJsonPath),
    //     // files: [],
    //   });
    // }

    logger.debug({ forceInclude }, 'Determining forceInclude paths');

    const extraGlobDirs = new Set<string>(forceInclude);
    forceInclude.forEach((name) => {
      getDependencyPathsFromModule(name, base, function shouldInclude(path) {
        const include = !extraGlobDirs.has(path);
        if (include) {
          extraGlobDirs.add(path);
        }
        return include;
      });
    });

    logger.debug({ additionalPaths: extraGlobDirs }, 'Got additional paths');

    logger.info(`Archiving files...`);
    await archiveFiles({
      base,
      pkgDir,
      outDir,
      files,
      extraGlobDirs: [...extraGlobDirs],
      format: resolvedConfig.archiveFormat,
    });

    // logger.info({ dependencies }, `Archiving dependencies...`);
    // await archiveDependencies({
    //   pkgDir,
    //   dependencies: Array.from(dependencies.values()),
    //   // dependencies: await traceDependencies(
    //   //   Object.fromEntries(
    //   //     Array.from(dependencies.entries()).map(([id, { version, files }]) => [
    //   //       id,
    //   //       version,
    //   //       files,
    //   //     ]),
    //   //   ) || {},
    //   //   dirname(entryPoint),
    //   // ),
    //   outDir,
    //   format: resolvedConfig.archiveFormat,
    // });

    logger.info(`Done. Files are at %s`, outDir);

    await cleanup();
  });
}
