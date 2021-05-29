import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, extname, resolve, relative } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL } from 'url';
import { archiveFiles } from './archive.js';
import { traceFiles } from './deps.js';
import { build } from './esbuild/build.js';
import { logger as parentLogger } from './logger.js';
import {
  BirudaBuildOptions,
  BirudaCliArguments,
  BirudaConfigFileProperties,
} from './types.js';
import {
  dedupeArray,
  getDependencyPathsFromModule,
  relativeUrl,
  serialPromiseMapAccum,
} from './utils.js';

const logger = parentLogger.child({ name: 'bundle' });

type ConfigFileExports =
  | BirudaConfigFileProperties
  | (() => BirudaConfigFileProperties)
  | (() => Promise<BirudaConfigFileProperties>);

function parseEntryPoints(
  entrypoint?: string[] | Record<string, string> | string,
): Record<string, string> {
  if (typeof entrypoint === 'string') {
    const name = basename(entrypoint).split('.').shift();

    if (!name) {
      throw new TypeError(`Bad entrypoint name: ${entrypoint}`);
    }

    return {
      [name]: entrypoint,
    };
  }
  if (Array.isArray(entrypoint)) {
    if (entrypoint.length === 1) {
      return {
        [basename(entrypoint[0], extname(entrypoint[0]))]: entrypoint[0],
      };
    }

    return Object.fromEntries(
      entrypoint.map((entryPoint) => {
        return [basename(entryPoint).split('.').shift(), entryPoint];
      }),
    );
  }
  return entrypoint || {};
}

export async function cliBundle(cliArguments: BirudaCliArguments) {
  const configPropsOrFunction: ConfigFileExports = cliArguments.config
    ? (
        await import(
          resolve(
            cliArguments.config ? dirname(cliArguments.config) : process.cwd(),
            cliArguments.config,
          )
        )
      ).default
    : ({} as BirudaConfigFileProperties);

  const config: BirudaConfigFileProperties =
    configPropsOrFunction instanceof Function
      ? await configPropsOrFunction()
      : configPropsOrFunction;

  const outDir = cliArguments.output || config.outDir;

  if (!outDir) {
    throw new TypeError('No outDir');
  }

  // archiver finalize() exits without error if the outDir doesnt exist
  await mkdir(outDir, {
    recursive: true,
  });

  const mergedEntryPoints = {
    ...parseEntryPoints(cliArguments.entrypoint),
    ...parseEntryPoints(config.entryPoints),
  };

  const resolvedConfig = {
    // default until we can reliably move to nodejs enable-source-maps
    // which doesnt seem to work reliably right now (april 2021)
    sourceMapSupport: true,
    verbose: cliArguments.verbose || config.verbose,
    sourceType: cliArguments.sourceType || config.sourceType || 'esm',
    minify:
      cliArguments.debug ||
      config.debug ||
      process.env.NODE_ENV === 'production',
    ...config,
    forceInclude: [
      ...(cliArguments.forceInclude || []),
      ...(config.forceInclude || []),
    ],
    entryPoints: mergedEntryPoints,
    archiveFormat: cliArguments.archiveFormat || config.archiveFormat || 'tar',
    compressionLevel: cliArguments.compressionLevel ?? config.compressionLevel,
  };

  const { entryPoints } = resolvedConfig;

  if (Object.keys(entryPoints).length === 0) {
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
    // forceBuild: resolvedConfig.forceBuild,
  };

  logger.info({ options }, 'build options');

  const { outputFiles, outputDir, packageJson, cleanup } = await build(options);

  const baseDir = pathToFileURL(dirname(outputDir));

  const { files, workspaceRoot } = await traceFiles(
    outputFiles.map(([, fileName]) => fileName),
    {
      baseDir,
      ignorePackages: [
        ...(resolvedConfig.forceInclude || []),
        ...(resolvedConfig.ignorePackages || []),
        // .filter(
        //   (pkg): pkg is string => typeof pkg === 'string',
        // ),
      ],
    },
  );

  if (resolvedConfig.forceInclude) {
    logger.info(
      resolvedConfig.forceInclude,
      'Force including %d paths/modules',
      resolvedConfig.forceInclude.length,
    );
  }

  const extras = new Set<string>();
  const modulePaths = new Set<string>(options.forceInclude);

  // should run serially due to path descending and caching
  await serialPromiseMapAccum(options.forceInclude || [], async (name) => {
    // local path
    if (name.startsWith('.') || name.startsWith('/')) {
      const rel = relative(fileURLToPath(baseDir), name);
      logger.trace({ name, baseDir }, 'force including file path %s', rel);
      extras.add(rel);
      return;
    }

    // default, assume module
    await getDependencyPathsFromModule(
      name,
      baseDir,
      workspaceRoot,
      function shouldDescend(modulePath, moduleName) {
        const include = !modulePaths.has(modulePath.toString());
        if (include) {
          logger.trace('[%s] processing %s', moduleName, modulePath);
          modulePaths.add(modulePath.toString());
        } else {
          logger.trace('[%s] ignoring %s', moduleName, modulePath);
        }
        return include;
      },
      function includeCallback(absPath) {
        const relPath = relativeUrl(workspaceRoot, absPath);
        if (!files.has(relPath)) {
          logger.trace(
            { absPath: absPath.toString() },
            '[%s] including path %s',
            name,
            relPath,
          );
          extras.add(relPath);
        } else {
          logger.trace(
            { absPath: absPath.toString() },
            '[%s] already got path %s',
            name,
            relPath,
          );
        }
      },
    );
  });

  // try and find anything that turned out to be behind a symlink, and then
  // add what we think might be the symlink
  options.forceInclude?.forEach((name) => {
    if (
      !name.startsWith('.') &&
      !name.startsWith('/') &&
      ![...extras].find((file) => file.startsWith(`node_modules/${name}`))
    ) {
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
    ...(options.sourceType === 'esm' && { type: 'module' }),
    // main: basename(outputFiles[0]),
    // scripts: Object.fromEntries(
    //   Object.entries(packageJson.scripts || {}).filter(([scriptName]) => {
    //     return !scriptName.match(/^(dev|build|test)(\W|$)/);
    //   }),
    // ),
    scripts: Object.fromEntries(
      outputFiles.map(([name, file]) => {
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

  await writeFile(
    resolve(outputDir, 'package.json'),
    JSON.stringify(newPackageJson, null, 2),
  );

  await archiveFiles({
    pkgDir: outputDir,
    files,
    extras,
    outDir,
    base: fileURLToPath(workspaceRoot),
    format: resolvedConfig.archiveFormat,
    compressionLevel: resolvedConfig.compressionLevel,
  });

  logger.info(`Done. Files are at %s`, pathToFileURL(outDir));
  await cleanup().catch((err) => logger.warn(err.message));
}
