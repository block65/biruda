import { dirname, isAbsolute, resolve } from 'path';
import { logger } from './logger';
import { traceFiles } from './deps';
import { archiveFiles } from './archive';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
  build,
} from './build';
import { serialPromiseMapAccum } from './utils';

function maybeMakeAbsolute(entry: string, baseDir: string): string {
  if (isAbsolute(entry)) {
    return entry;
  }
  return resolve(baseDir, entry);
}
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

    logger.info(`Starting build...`);

    const { tmpFile: pkgFile, tmpDir: pkgDir, cleanup } = await build(options);

    logger.info(
      `Tracing remaining dependencies. wd: %s`,
      dirname(absoluteEntryPoint),
    );

    // const dependencies = await traceFileDependencies(pkgFile, {
    //   workingDirectory: dirname(absoluteEntryPoint),
    //   ignorePackages: resolvedConfig.ignorePackages,
    // });

    const { files, base } = await traceFiles(pkgFile, {
      originalEntryPoint: absoluteEntryPoint,
      ignorePackages: resolvedConfig.ignorePackages,
    });

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

    logger.info(`Archiving files...`);
    await archiveFiles({
      base,
      pkgDir,
      outDir,
      files,
      extraGlobDirs: [
        ...forceInclude.map((name) => {
          return dirname(
            require.resolve(`${name}/package.json`, {
              paths: [dirname(absoluteEntryPoint)],
            }),
          );
        }),
      ],
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
