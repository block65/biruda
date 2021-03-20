import { dirname, relative, resolve } from 'path';
import { logger as parentLogger } from './logger';
import { traceFiles } from './deps';
import { archiveFiles } from './archive';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
} from './types';
import {
  dedupeArray,
  getDependencyPathsFromModule,
  maybeMakeAbsolute,
  serialPromiseMapAccum,
} from './utils';
import { build } from './esbuild/build';

const logger = parentLogger.child({ name: 'bundle' });

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

  const { entryPoints = [], ...restConfig } = resolvedConfig;

  if (entryPoints.length === 0) {
    throw new TypeError('No entryPoints');
  }

  if (entryPoints.length > 1) {
    throw new TypeError('Only 1 entryPoint supported right now');
  }

  await serialPromiseMapAccum(entryPoints, async (entryPoint) => {
    const absoluteEntryPoint = maybeMakeAbsolute(entryPoint, process.cwd());

    const options: Omit<BirudaBuildOptions, 'entryPoints'> = {
      platform: 'node',
      entryPoint: absoluteEntryPoint,
      ...restConfig,
      outDir,
      externals: dedupeArray([
        ...(restConfig.sourceMapSupport ? ['source-map-support'] : []),
        ...(restConfig.externals || []),
      ]),
      forceInclude: dedupeArray([
        ...(restConfig.sourceMapSupport ? ['source-map-support'] : []),
        ...(resolvedConfig.forceInclude || []),
      ]),
    };

    const { tmpFile: pkgFile, tmpDir: pkgDir, cleanup } = await build(options);

    const { files, base } = await traceFiles(pkgFile, {
      originalEntryPoint: absoluteEntryPoint,
      ignorePackages: [
        ...(resolvedConfig.forceInclude || []),
        ...(resolvedConfig.ignorePackages || []),
      ],
    });

    logger.info(
      'Force including %d modules',
      options.forceInclude?.length || 0,
    );

    const extras = new Set<string>();
    const modulePaths = new Set<string>(options.forceInclude);
    options.forceInclude?.forEach((name) => {
      getDependencyPathsFromModule(
        name,
        base,
        function shouldDescend(modulePath, moduleName) {
          const include = !modulePaths.has(modulePath);
          if (include) {
            logger.trace('[%s] processing %s', moduleName, modulePath);
            modulePaths.add(modulePath);
          } else {
            logger.trace('[%s] ignoring %s', moduleName, modulePath);
          }
          return include;
        },
        function includeCallback(absPath) {
          const relPath = relative(base, absPath);
          if (!files.has(relPath)) {
            logger.trace('[%s] including path %s', name, relPath);
            extras.add(relPath);
          } else {
            logger.trace('[%s] already got path %s', name, relPath);
          }
        },
      );
    });

    // try and find anything that turned out to be behind a symlink, and then
    // add what we think might be the symlink
    options.forceInclude?.forEach((name) => {
      if (
        ![...extras].find((file) => file.startsWith(`node_modules/${name}`))
      ) {
        logger.trace(
          '%s did not have any files, assuming symlink and adding top level',
          name,
        );
        extras.add(`node_modules/${name}`);
      }
    });

    await archiveFiles({
      pkgDir,
      files,
      extras,
      outDir,
      base,
      format: resolvedConfig.archiveFormat,
    });

    logger.info(`Done. Files are at %s`, outDir);

    await cleanup();
  });
}
