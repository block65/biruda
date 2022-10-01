import assert from 'node:assert';
import {
  cp,
  lstat,
  mkdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Arborist from '@npmcli/arborist';
import packlist from 'npm-packlist';
import { packageDirectory } from 'pkg-dir';
import type { PackageJson } from 'type-fest';
import { findWorkspaceRoot, loadPackageJson, traceFiles } from './deps.js';
import { build } from './esbuild/build.js';
import { logger as parentLogger } from './logger.js';
import {
  BirudaCliArguments,
  BirudaConfigFileProperties,
  BirudaOptions,
} from './types.js';
import { dirSize, serialPromiseMap } from './utils.js';

const logger = parentLogger.child({}, { context: { name: 'bundle' } });

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
      entryPoints.map((entryPoint) => [
        basename(entryPoint).split('.').at(0),
        entryPoint,
      ]),
    ) as Record<string, string>;
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

  const [packageJson] = await loadPackageJson(workingDirectory);

  const configFileProps: BirudaConfigFileProperties =
    configPropsOrFunction instanceof Function
      ? await configPropsOrFunction(options, packageJson)
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
    // logger.level = resolvedConfig.logLevel;
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

  const additionalFiles = new Set<string>(resolvedConfig.extraPaths);

  // must run serially due to path descending and caching
  // eslint-disable-next-line no-restricted-syntax
  for await (const moduleName of [
    ...(resolvedConfig.externals || []),
    ...resolvedConfig.extraModules,
  ] || []) {
    logger.info('[%s] resolving module deps + files', moduleName);

    const require = createRequire(workingDirectory);

    const resolvedFrom = require.resolve(moduleName, {
      paths: [fileURLToPath(workingDirectory)],
    });

    const fromPkgDir = await packageDirectory({
      cwd: resolvedFrom,
    });

    assert(fromPkgDir, 'fromPkgDir empty');
    logger.info({ fromPkgDir });

    const arb = new Arborist({
      path: fromPkgDir,
    });

    const tree = await arb.loadActual();
    const npmFileList = await packlist(tree);

    npmFileList.forEach((f: string) => {
      const filePath = relative(
        fileURLToPath(workspaceRoot),
        join(fromPkgDir, f),
      );
      additionalFiles.add(filePath);
    });
  }

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
      outputFiles.map(([name, file]) => [
        name === 'index' ? 'start' : name,
        `node ${basename(file)}`,
      ]),
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

  const augmentedFiles = await serialPromiseMap(
    [...files, ...additionalFiles],
    async (file) => {
      logger.info(file, 'Copying file %s', file);
      const srcFile = join(workspaceRootAsPath, file);
      const srcFileStat = await lstat(srcFile);

      const destFile = join(outDirAsPath, file);
      const destDir = dirname(destFile);

      const isSymlink = srcFileStat.isSymbolicLink();
      return { file, srcFile, destFile, destDir, isSymlink };
    },
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
    'Done. Output at %s (~%skb in %d files)',
    outDir,
    new Intl.NumberFormat().format(Math.round(size / 1024)),
    files,
  );
}
