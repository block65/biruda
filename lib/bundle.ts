import assert from 'node:assert';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import glob from 'glob-promise';
import { packageDirectory } from 'pkg-dir';
import { readPackage } from 'read-pkg';
import { traceFiles } from 'trace-deps';
import type { PackageJson } from 'type-fest';
import { findWorkspaceRoot, loadPackageJson } from './deps.js';
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
  const workspaceRootAsPath = fileURLToPath(workspaceRoot);

  const deps = await traceFiles({
    srcPaths: outputFiles.map(([, fileName]) => fileName),
    allowMissing: {
      '@aws-sdk/util-user-agent-node': ['aws-crt'],
      '@aws-sdk/signature-v4-multi-region': ['@aws-sdk/signature-v4-crt'],
      'retry-request': ['request'],
      'node-fetch': ['encoding'],
      mongodb: [
        'bson-ext',
        'mongodb-client-encryption',
        '@mongodb-js/zstd',
        'snappy',
        'aws4',
        'kerberos',
      ],
    },
  });

  // logger.info({ srcPath: outputFiles.map(([, fileName]) => fileName), deps });

  const uniquePackageDirs = [
    ...new Set(
      deps.dependencies
        .map((d) => relative(workspaceRootAsPath, d))
        .map((f) => f.match(/(.*node_modules\/(@.*?\/.*?|.*?))\//))
        .filter((m): m is string[] => !!m)
        .map((m) => m[0]),
    ),
  ];

  const externalPaths = new Set<string>(resolvedConfig.extraPaths);

  async function generatePacklistActual(modulePath: string, base: URL) {
    const modulePkgDir = await packageDirectory({
      cwd: join(fileURLToPath(base), modulePath),
    });
    assert(modulePkgDir, 'modulePkgDir empty');

    // logger.info('Creating packlist from %s', modulePkgDir);
    const manifest = await readPackage({ cwd: modulePkgDir });

    // we only really use globs because we're in our own monorepo
    // and the package may not be published
    const packlist = (
      await Promise.all(
        [
          ...(manifest.files || ['*']), // no `files[]` -> copy everything
          ...(manifest.main || []), // add main, as it may not be in `files`
          ...(manifest.module || []), // add module, as it may not be in `files`
          'package.json',
          'readme*',
          'license*',
        ].map((pattern) =>
          glob.promise(pattern.startsWith('/') ? `.${pattern}` : pattern, {
            cwd: modulePkgDir,
            // lockfiles are redundant, we're already *installed*
            ignore: ['yarn.lock', 'package-lock.json', '**/*.js.map'],
          }),
        ),
      )
    ).flat();

    // logger.info({ tree }, 'tree for %s', moduleName);
    // logger.info({ packlist }, 'packlist for %s', modulePath);

    packlist.forEach((f: string) => {
      const filePath = relative(
        fileURLToPath(workspaceRoot),
        join(modulePkgDir, f),
      );
      externalPaths.add(filePath);
    });
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const moduleName of [
    // ...(uniquePackageDirs || []),
    // ...(resolvedConfig.externals || []),
    // ...resolvedConfig.extraModules,
    ...uniquePackageDirs,
  ] || []) {
    await generatePacklistActual(moduleName, workspaceRoot);
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

  const filesWithStat = await serialPromiseMap(
    [...new Set([...externalPaths])],
    async (file) => {
      // logger.info('Stating file %s', file);
      const srcFile = join(workspaceRootAsPath, file);
      const srcFileStat = await lstat(srcFile);

      const destFile = join(outDirAsPath, file);
      const destDir = dirname(destFile);

      const isSymlink = srcFileStat.isSymbolicLink();
      return { file, srcFile, destFile, destDir, isSymlink };
    },
  );

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of filesWithStat.filter(
    ({ isSymlink }) => !isSymlink,
  )) {
    // logger.info('Copying file %s to %s', file.srcFile, file.destFile);
    await cp(file.srcFile, file.destFile, {
      errorOnExist: true, // safety first, could be a bug
      recursive: true,
      // verbatimSymlinks: true, // node17 only
    }).catch(logger.warn);
  }

  // WARN: copy new manifest, this overwrites the one there already
  await writeFile(
    new URL('package.json', outDir),
    JSON.stringify(newPackageJson, null, 2),
  );

  await cleanup().catch((err) => logger.warn(err.message));

  return {
    outDir,
    filesWithStat,
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
