import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { archiveFiles } from './archive.js';
import { findWorkspaceRoot, loadPackageJson, traceFiles } from './deps.js';
import { build } from './esbuild/build.js';
import { logger as parentLogger } from './logger.js';
import { BirudaCliArguments, BirudaConfigFileProperties } from './types.js';
import { getDependencyPathsFromModule, relativeFileUrl } from './utils.js';

const logger = parentLogger.child({ name: 'bundle' });

type ConfigFileExports =
  | BirudaConfigFileProperties
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson,
    ) => BirudaConfigFileProperties)
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson,
    ) => Promise<BirudaConfigFileProperties>);

function parseEntryPoints(
  entryPoints?: string[] | Record<string, string> | string,
): Record<string, string> {
  if (typeof entryPoints === 'string') {
    const name = basename(entryPoints).split('.').at(0);

    if (!name) {
      throw new TypeError(`Bad entrypoint name: ${entryPoints}`);
    }

    return {
      [name]: entryPoints,
    };
  }

  if (Array.isArray(entryPoints)) {
    if (entryPoints.length === 1) {
      return {
        [basename(entryPoints[0], extname(entryPoints[0]))]: entryPoints[0],
      };
    }

    return Object.fromEntries(
      entryPoints.map((entryPoint) => {
        return [basename(entryPoint).split('.').at(0), entryPoint];
      }),
    );
  }

  return entryPoints || {};
}

export async function cliBundle(cliArguments: BirudaCliArguments) {
  const configPropsOrFunction: ConfigFileExports = cliArguments.configFile
    ? (
        await import(
          resolve(
            cliArguments.configFile
              ? dirname(cliArguments.configFile)
              : process.cwd(),
            cliArguments.configFile,
          )
        )
      ).default
    : {};

  const workingDirectory = pathToFileURL(join(process.cwd(), '/'));

  const configFileProps: BirudaConfigFileProperties =
    configPropsOrFunction instanceof Function
      ? await configPropsOrFunction(
          cliArguments,
          await loadPackageJson(workingDirectory),
        )
      : configPropsOrFunction;

  const resolvedConfig = {
    // defaults
    logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    sourceType: 'esm' as const,
    debug: process.env.NODE_ENV === 'development',
    archiveFormat: 'tar' as const,

    // Primitive CLI options take precedence
    ...configFileProps,
    ...cliArguments,

    // Non-primitives are merged
    entryPoints: {
      ...parseEntryPoints(configFileProps.entryPoints),
      ...parseEntryPoints(cliArguments.entryPoints),
    },
    extraModules: [
      ...(cliArguments.extraModules || []),
      ...(configFileProps.extraModules || []),
      ...(configFileProps.sourceMapSupport || cliArguments.sourceMapSupport
        ? ['source-map-support']
        : []),
    ],
    extraPaths: [
      ...(cliArguments.extraPaths || []),
      ...(configFileProps.extraPaths || []),
    ],
  };

  if (resolvedConfig.logLevel) {
    logger.level = resolvedConfig.logLevel;
  }

  logger.fatal({ resolvedConfig, cliArguments, configFileProps });

  const { entryPoints } = resolvedConfig;

  if (Object.keys(entryPoints).length === 0) {
    throw new TypeError('No entryPoints provided');
  }

  const outDir = resolvedConfig.outDir;

  if (!outDir) {
    throw new TypeError('No outDir');
  }

  // archiver finalize() exits without error if the outDir doesnt exist
  await mkdir(outDir, {
    recursive: true,
  });

  const { outputFiles, outputDir, cleanup } = await build({
    workingDirectory,
    entryPoints: resolvedConfig.entryPoints,
    externals: resolvedConfig.externals,
    ignorePackages: resolvedConfig.ignorePackages,
    sourceType: resolvedConfig.sourceType,
    debug: resolvedConfig.debug,
  });

  const workspaceRoot = await findWorkspaceRoot(workingDirectory);

  const { files } = await traceFiles(
    outputFiles.map(([, fileName]) => fileName),
    {
      workspaceRoot,
      ignorePackages: [
        // dont need to trace extraModules, because we will always add everything
        // ...(resolvedConfig.extraModules || []),
        ...(resolvedConfig.ignorePackages || []),
        // .filter(
        //   (pkg): pkg is string => typeof pkg === 'string',
        // ),
      ],
    },
  );

  logger.warn({ resolvedConfig }, 'resolvedConfig');

  if (resolvedConfig.extraModules && resolvedConfig.extraModules.length > 0) {
    logger.info(
      resolvedConfig.extraModules,
      'Including %d modules',
      resolvedConfig.extraModules.length,
    );
  }

  const extras = new Set<string>(resolvedConfig.extraPaths);
  const modulePaths = new Set<string>();

  // must run serially due to path descending and caching
  for await (const name of resolvedConfig.extraModules || []) {
    logger.trace('[%s] getting deps for extra module %s', name);

    await getDependencyPathsFromModule(
      name,
      workingDirectory,
      workspaceRoot,
      function shouldDescend(modulePath, moduleName) {
        const include = !modulePaths.has(modulePath.toString());
        if (include) {
          logger.trace('[%s] including %s', moduleName, modulePath);
          modulePaths.add(modulePath.toString());
        } else {
          logger.trace('[%s] ignoring %s', moduleName, modulePath);
        }
        return include;
      },
      function includeCallback(path) {
        const relPath = relativeFileUrl(workspaceRoot, path);
        if (!files.has(new URL(`./${relPath}`, workspaceRoot).toString())) {
          logger.info(
            { path: path.toString() },
            '[%s] including path %s',
            name,
            relPath,
          );
          extras.add(relPath);
        } else {
          logger.info(
            { absPath: path.toString() },
            '[%s] already got path %s',
            name,
            relPath,
          );
        }
      },
    );
  }

  const packageJson = await loadPackageJson(workingDirectory);

  const newPackageJson: PackageJson.PackageJsonStandard = {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    private: packageJson.private,
    ...(resolvedConfig.sourceType === 'esm' && { type: 'module' }),
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
    join(outputDir, 'package.json'),
    JSON.stringify(newPackageJson, null, 2),
  );

  await archiveFiles({
    workspaceRoot,
    bundleSource: outputDir,
    bundleDest: relative(
      fileURLToPath(workspaceRoot),
      fileURLToPath(workingDirectory),
    ),
    files,
    extras,
    outDir,
    format: resolvedConfig.archiveFormat,
    compressionLevel: resolvedConfig.compressionLevel,
  });

  logger.info(`Done. Files are at %s`, pathToFileURL(outDir));
  await cleanup().catch((err) => logger.warn(err.message));
}
