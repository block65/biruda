import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { archiveFiles } from './archive.js';
import { findWorkspaceRoot, loadPackageJson, traceFiles } from './deps.js';
import { build } from './esbuild/build.js';
import { logger as parentLogger } from './logger.js';
import { BirudaBuildOptions, BirudaCliArguments } from './types.js';
import {
  dedupeArray,
  getDependencyPathsFromModule,
  relativeFileUrl,
} from './utils.js';

const logger = parentLogger.child({ name: 'bundle' });

type ConfigFileExports =
  | BirudaCliArguments
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson,
    ) => BirudaCliArguments)
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson,
    ) => Promise<BirudaCliArguments>);

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
  const configPropsOrFunction: ConfigFileExports = cliArguments.config
    ? (
        await import(
          resolve(
            cliArguments.config ? dirname(cliArguments.config) : process.cwd(),
            cliArguments.config,
          )
        )
      ).default
    : {};

  const workingDirectory = pathToFileURL(join(process.cwd(), '/'));

  const config: BirudaCliArguments =
    configPropsOrFunction instanceof Function
      ? await configPropsOrFunction(
          cliArguments,
          await loadPackageJson(workingDirectory),
        )
      : configPropsOrFunction;

  const mergedEntryPoints = parseEntryPoints(config.entryPoints);

  const resolvedConfig = {
    // default until we can reliably move to nodejs enable-source-maps
    // which doesnt seem to work reliably right now (april 2021)
    sourceMapSupport: true,
    logLevel:
      config.logLevel ||
      (process.env.NODE_ENV === 'development' ? 'debug' : 'info'),
    sourceType: config.sourceType || 'esm',
    debug: config.debug || process.env.NODE_ENV === 'development',
    ...config,
    extraModules: [
      ...(cliArguments.extraModules || []),
      ...(config.extraModules || []),
    ],
    extraPaths: [
      ...(cliArguments.extraPaths || []),
      ...(config.extraPaths || []),
    ],
    entryPoints: mergedEntryPoints,
    archiveFormat: cliArguments.archiveFormat || config.archiveFormat || 'tar',
    compressionLevel: cliArguments.compressionLevel ?? config.compressionLevel,
  };

  if (resolvedConfig.logLevel) {
    logger.level = resolvedConfig.logLevel;
  }

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

  const options: BirudaBuildOptions = {
    platform: 'node',
    ...resolvedConfig,
    entryPoints,
    outDir,
    externals: dedupeArray([
      ...(resolvedConfig.sourceMapSupport ? ['source-map-support'] : []),
      ...(resolvedConfig.externals || []),
    ]),
    extraModules: dedupeArray([
      ...(resolvedConfig.sourceMapSupport ? ['source-map-support'] : []),
      ...(resolvedConfig.extraModules || []),
    ]),
    // forceBuild: resolvedConfig.forceBuild,
    workingDirectory,
  };

  logger.trace({ options }, 'build options');

  const { outputFiles, outputDir, cleanup } = await build(options);

  const packageJson = await loadPackageJson(options.workingDirectory);

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

  if (resolvedConfig.extraModules.length > 0) {
    logger.info(
      resolvedConfig.extraModules,
      'Including %d modules',
      resolvedConfig.extraModules.length,
    );
  }

  const extras = new Set<string>(resolvedConfig.extraPaths);
  const modulePaths = new Set<string>();

  // should run serially due to path descending and caching
  for await (const name of resolvedConfig.extraModules) {
    // await serialPromiseForEach(resolvedConfig.extraModules, async (name) => {
    // local path
    if (name.startsWith('.') || name.startsWith('/')) {
      const rel = relative(fileURLToPath(workspaceRoot), name);
      logger.trace(
        { name, workspaceRoot: workspaceRoot.toString() },
        'force including file path %s',
        rel,
      );
      extras.add(rel);
      return;
    }

    // default, assume module
    await getDependencyPathsFromModule(
      name,
      workingDirectory,
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
