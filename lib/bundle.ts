import { dirname, relative, resolve } from 'path';
import { writeFileSync } from 'fs';
import { logger as parentLogger } from './logger';
import { traceFiles } from './deps';
import { archiveFiles } from './archive';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
  build,
} from './build';
import {
  dedupeArray,
  getDependencyPathsFromModule,
  maybeMakeAbsolute,
  serialPromiseMapAccum,
} from './utils';

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
    throw new TypeError('Only 1 entryPoint supported so far');
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

    logger.info(
      `Tracing remaining dependencies. wd: %s`,
      dirname(absoluteEntryPoint),
    );

    const { files, base } = await traceFiles(pkgFile, {
      originalEntryPoint: absoluteEntryPoint,
      ignorePackages: [
        ...(resolvedConfig.forceInclude || []),
        ...(resolvedConfig.ignorePackages || []),
      ],
    });

    writeFileSync(
      `${__dirname}/kke.json`,
      JSON.stringify(
        {
          files: [...files],
          ignorePackages: [
            ...(resolvedConfig.forceInclude || []),
            ...(resolvedConfig.ignorePackages || []),
          ],
        },
        null,
        2,
      ),
    );

    logger.debug(
      { forceInclude: options.forceInclude },
      'Determining forceInclude paths',
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
            logger.trace('[%s] including module %s', moduleName, modulePath);
            modulePaths.add(modulePath);
          } else {
            logger.trace('[%s] ignoring module %s', moduleName, modulePath);
          }
          return include;
        },
        function includeCallback(absPath) {
          const relPath = relative(base, absPath);
          if (!files.has(relPath)) {
            logger.trace('[%s] including path %s', name, relPath);
            extras.add(relPath);
          } else {
            logger.warn('[%s] already got path %s', name, relPath);
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
        logger.warn(
          '%s did not have any files, assuming symlink and adding top level',
          name,
        );
        extras.add(`node_modules/${name}`);
      }
    });

    logger.info(`Archiving files...`);
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
