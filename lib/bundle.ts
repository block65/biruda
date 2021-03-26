import type { PackageJson } from 'type-fest';
import { basename, dirname, relative, resolve } from 'path';
import { promises as fsPromises, writeFileSync } from 'fs';
import { logger as parentLogger } from './logger';
import { traceFiles } from './deps';
import { archiveFiles } from './archive';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
} from './types';
import { dedupeArray, getDependencyPathsFromModule } from './utils';
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

  // archiver finalize() exits without error if the outDir doesnt exist
  await fsPromises.mkdir(outDir, {
    recursive: true,
  });

  const cliEntrypoints =
    cliArguments.entrypoint?.length === 1
      ? { index: cliArguments.entrypoint[0] }
      : Object.fromEntries(
          (cliArguments.entrypoint || []).map((entryPoint) => {
            return [basename(entryPoint).split('.').shift(), entryPoint];
          }),
        );

  const resolvedConfig = {
    entryPoints: { ...cliEntrypoints, ...configFileProps.entryPoints },
    verbose: cliArguments.verbose || configFileProps.verbose,
    sourceMapSupport: false,
    ...configFileProps,
  };

  const { entryPoints } = resolvedConfig;

  if (!entryPoints) {
    throw new TypeError('No entryPoints provided');
  }

  const options: BirudaBuildOptions = {
    platform: 'node',
    ...resolvedConfig,
    entryPoints,
    outDir,
    externals: dedupeArray([
      ...(resolvedConfig.sourceMapSupport ? ['source-map-support'] : []),
      ...(resolvedConfig.externals || []),
    ]),
    forceInclude: dedupeArray([
      ...(resolvedConfig.sourceMapSupport ? ['source-map-support'] : []),
      ...(resolvedConfig.forceInclude || []),
    ]),
  };

  const { outputFiles, outputDir, packageJson, cleanup } = await build(options);

  const { files, base } = await traceFiles(Object.values(outputFiles), {
    baseDir: outputDir,
    ignorePackages: [
      ...(resolvedConfig.forceInclude || []),
      ...(resolvedConfig.ignorePackages || []).filter(
        (pkg): pkg is string => typeof pkg === 'string',
      ),
    ],
  });

  logger.info('Force including %d modules', options.forceInclude?.length || 0);

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
    if (![...extras].find((file) => file.startsWith(`node_modules/${name}`))) {
      logger.trace(
        '%s did not have any files, assuming symlink and adding top level',
        name,
      );
      extras.add(`node_modules/${name}`);
    }
  });

  const newPackageJson: PackageJson.PackageJsonStandard = {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    private: packageJson.private,
    // main: basename(outputFiles[0]),
    // scripts: Object.fromEntries(
    //   Object.entries(packageJson.scripts || {}).filter(([scriptName]) => {
    //     return !scriptName.match(/^(dev|build|test)(\W|$)/);
    //   }),
    // ),
    scripts: Object.fromEntries(
      Object.entries(outputFiles).map(([name, file]) => {
        return [name === 'index' ? 'start' : name, `node ${basename(file)}`];
      }),
    ),
    // dependencies: Object.fromEntries(
    //   Array.from(buildResult..entries()).map(([id, { version }]) => [
    //     id,
    //     version,
    //   ]),
    // ),
  };

  writeFileSync(
    resolve(outputDir, 'package.json'),
    JSON.stringify(newPackageJson, null, 2),
  );

  await archiveFiles({
    pkgDir: outputDir,
    files,
    extras,
    outDir,
    base,
    format: resolvedConfig.archiveFormat,
  });

  logger.info(`Done. Files are at %s`, outDir);
  await cleanup().catch((err) => logger.warn(err.message));
}
