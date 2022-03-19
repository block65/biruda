import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readlink,
  symlink,
  writeFile,
} from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import type { PackageJson } from 'type-fest';
import { fileURLToPath, pathToFileURL, URL } from 'url';
import { findWorkspaceRoot, loadPackageJson, traceFiles } from './deps.js';
import { build } from './esbuild/build.js';
import { logger as parentLogger } from './logger.js';
import {
  BirudaCliArguments,
  BirudaConfigFileProperties,
  BirudaOptions,
} from './types.js';
import {
  dirSize,
  getDependencyPathsFromModule,
  relativeFileUrl,
} from './utils.js';

const logger = parentLogger.child({ name: 'bundle' });

type ConfigFileExports =
  | BirudaConfigFileProperties
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson | null,
    ) => BirudaConfigFileProperties)
  | ((
      cliArguments: BirudaCliArguments,
      manifest: PackageJson | null,
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

export async function bundle(options: BirudaOptions) {
  const configFileLocation =
    options.configFile &&
    resolve(
      options.configFile ? dirname(options.configFile) : process.cwd(),
      options.configFile,
    );

  const configPropsOrFunction: ConfigFileExports = configFileLocation
    ? (await import(configFileLocation)).default
    : {};

  const workingDirectory = configFileLocation
    ? pathToFileURL(join(dirname(configFileLocation), '/'))
    : pathToFileURL(join(process.cwd(), '/'));

  const configFileProps: BirudaConfigFileProperties =
    configPropsOrFunction instanceof Function
      ? await configPropsOrFunction(
          options,
          await loadPackageJson(workingDirectory),
        )
      : configPropsOrFunction;

  const resolvedConfig = {
    // defaults
    logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
    sourceType: 'esm' as const,
    debug: process.env.NODE_ENV === 'development',

    // Primitive CLI options take precedence
    ...configFileProps,
    ...options,

    // Non-primitives are merged
    entryPoints: {
      ...parseEntryPoints(configFileProps.entryPoints),
      ...parseEntryPoints(options.entryPoints),
    },
    extraModules: [
      ...(options.extraModules || []),
      ...(configFileProps.extraModules || []),
    ],
    extraPaths: [
      ...(options.extraPaths || []),
      ...(configFileProps.extraPaths || []),
    ],
  };

  if (resolvedConfig.logLevel) {
    logger.level = resolvedConfig.logLevel;
  }

  // logger.trace({ resolvedConfig, cliArguments, configFileProps });

  const { entryPoints } = resolvedConfig;

  if (Object.keys(entryPoints).length === 0) {
    throw new TypeError('No entryPoints provided');
  }

  if (!resolvedConfig.outDir) {
    throw new TypeError('No outDir');
  }

  const outDir = new URL(`${resolvedConfig.outDir}/`, workingDirectory);

  const { outputFiles, buildDir, cleanup } = await build({
    workingDirectory,
    entryPoints: resolvedConfig.entryPoints,
    externals: resolvedConfig.externals,
    ignorePackages: resolvedConfig.ignorePackages,
    sourceType: resolvedConfig.sourceType,
    debug: resolvedConfig.debug,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      ...(resolvedConfig.versionName && {
        'process.env.VERSION_NAME': JSON.stringify(resolvedConfig.versionName),
      }),
    },
  });

  const workspaceRoot = await findWorkspaceRoot(workingDirectory);

  const { files } = await traceFiles(
    outputFiles.map(([, fileName]) => fileName),
    {
      workspaceRoot,
      ignorePaths: ['node:*', relative(fileURLToPath(workspaceRoot), buildDir)],
      ignorePackages: [
        // don't need to trace extraModules, because we will always add everything
        // ...(resolvedConfig.extraModules || []),
        ...(resolvedConfig.ignorePackages || []),
        // .filter(
        //   (pkg): pkg is string => typeof pkg === 'string',
        // ),

        // extraModules are ignored because we will copy the entire
        // module and its deps later, no point tracing it
        ...resolvedConfig.extraModules,
      ],
    },
  );

  if (resolvedConfig.extraModules && resolvedConfig.extraModules.length > 0) {
    logger.info(
      resolvedConfig.extraModules,
      'Including %d extra modules',
      resolvedConfig.extraModules.length,
    );
  }

  const extras = new Set<string>(resolvedConfig.extraPaths);
  const modulePaths = new Set<string>();

  // must run serially due to path descending and caching
  // eslint-disable-next-line no-restricted-syntax
  for await (const name of resolvedConfig.extraModules || []) {
    logger.info('[%s] resolving module deps + files', name);

    await getDependencyPathsFromModule(
      name,
      workingDirectory,
      workspaceRoot,
      function shouldDescend(modulePath, moduleName) {
        const include = !modulePaths.has(modulePath.toString());
        if (include) {
          logger.info('[%s] including module %s', moduleName, modulePath);
          modulePaths.add(modulePath.toString());
        } else {
          logger.info('[%s] ignoring %s', moduleName, modulePath);
        }
        return include;
      },
      function includeCallback(path) {
        const relPath = relativeFileUrl(workspaceRoot, path);
        if (!files.has(new URL(`./${relPath}`, workspaceRoot).toString())) {
          logger.info(
            // { path: path.toString() },
            '[%s] including path %s',
            name,
            relPath,
          );
          extras.add(relPath);
        } else {
          logger.info(
            // { absPath: path.toString() },
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
    name: packageJson?.name,
    version: packageJson?.version,
    license: packageJson?.license,
    private: packageJson?.private,
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

  const outDirAsPath = fileURLToPath(outDir);
  const workspaceRootAsPath = fileURLToPath(workspaceRoot);

  await mkdir(outDir, {
    recursive: true,
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  });

  logger.trace(
    'Copying built files from %s to %s',
    buildDir,
    join(
      outDirAsPath,
      relative(workspaceRootAsPath, fileURLToPath(workingDirectory)),
    ),
  );

  // copy built files
  await cp(
    buildDir,
    join(
      outDirAsPath,
      relative(workspaceRootAsPath, fileURLToPath(workingDirectory)),
    ),
    { recursive: true },
  );

  const augmentedFiles = await Promise.all(
    [...files, ...extras].map(async (file) => {
      const srcFile = join(workspaceRootAsPath, file);
      const srcFileStat = await lstat(srcFile);

      const destFile = join(outDirAsPath, file);
      const destDir = dirname(destFile);

      const isSymlink = srcFileStat.isSymbolicLink();
      return { file, srcFile, destFile, destDir, isSymlink };
    }),
  );

  const destDirs = new Set(augmentedFiles.map(({ destDir }) => destDir));
  // eslint-disable-next-line no-restricted-syntax
  for await (const dir of destDirs) {
    await mkdir(dir, {
      recursive: true,
    });
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of augmentedFiles.filter(
    ({ isSymlink }) => !isSymlink,
  )) {
    // await copyFile(file.srcFile, file.destFile); // , {
    await cp(file.srcFile, file.destFile, {
      errorOnExist: true, // safety first, could be a bug
      recursive: true,
      //   verbatimSymlinks: true, // node17 only
    });
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of augmentedFiles.filter(
    ({ isSymlink }) => isSymlink,
  )) {
    const target = await readlink(file.srcFile);
    await symlink(target, file.destFile);
  }

  // WARN: copy new manifest, this overwrites the one there already
  await writeFile(
    new URL('package.json', outDir),
    JSON.stringify(newPackageJson, null, 2),
  );

  await cleanup().catch((err) => logger.warn(err.message));

  return {
    outDir,
    files,
  };
}

export async function cliBundle(cliArguments: BirudaCliArguments) {
  const { outDir } = await bundle(
    // remove undefined props
    Object.fromEntries(
      Object.entries(cliArguments).filter(([, v]) => v !== undefined),
    ),
  );

  const [files, size] = [Infinity, Infinity] || (await dirSize(outDir));

  logger.info(
    `Done. Output at %s (~%skb in %d files)`,
    outDir,
    new Intl.NumberFormat().format(Math.round(size / 1024)),
    files,
  );
}
