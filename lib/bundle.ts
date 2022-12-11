import assert from 'node:assert';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
    bailOnMissing: true,
    allowMissing: {
      '@aws-sdk/util-user-agent-node': ['aws-crt'],
      '@aws-sdk/signature-v4-multi-region': ['@aws-sdk/signature-v4-crt'],
      'retry-request': ['request'],
      'node-fetch': ['encoding'],
      'cross-spawn': ['spawn-sync'], // cross-spawn tries to maintain node 0.10 compat XD
      ws: [
        // See, e.g.: https://github.com/websockets/ws/blob/08c6c8ba70404818f7f4bc23eb5fd0bf9c94c039/lib/buffer-util.js#L121-L122
        'bufferutil',
        // See, e.g.: https://github.com/websockets/ws/blob/b6430fea423d88926847a47d4ecfc36e52dc1164/lib/validation.js#L3-L10
        'utf-8-validate',
      ],
      mongodb: [
        'bson-ext',
        'mongodb-client-encryption',
        '@mongodb-js/zstd',
        '@mongodb-js/zstd-darwin-x64',
        '@mongodb-js/zstd-darwin-arm64',
        'snappy',
        'aws4',
        'kerberos',
      ],
    },
  });

  // special cases where we need to manually intervene and force package inclusion
  const specialCases: RegExp[] = [/clone-deep\/utils\.js$/];

  const specialCasePaths = Object.entries(deps.misses)
    .filter(([missPath]) => specialCases.some((p) => missPath.match(p)))
    .map(([missPath]) => missPath);

  function toModulePaths(files: string[], base: URL): string[] {
    return files
      .map((d) => relative(fileURLToPath(base), d))
      .map((f) => f.match(/(.*node_modules\/(@.*?\/.*?|.*?))\//))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => m[0]);
  }

  // resolve all of the dependencies from the manifest
  // for each of the special case paths we found
  const specialCaseEntrypoints = await Promise.all(
    toModulePaths(specialCasePaths, workspaceRoot).map(
      async (relativeModulePath) => {
        logger.info({ modulePath: relativeModulePath });

        const modulePkgDir = await packageDirectory({
          cwd: join(workspaceRootAsPath, relativeModulePath),
        });
        assert(modulePkgDir, 'modulePkgDir falsy');

        const manifest = await readPackage({ cwd: modulePkgDir });

        const req = createRequire(modulePkgDir);

        return Object.keys({ ...manifest.dependencies }).map((d) =>
          req.resolve(d),
        );
      },
    ),
  );

  const specialCaseTraceResult = await traceFiles({
    srcPaths: specialCaseEntrypoints.flat(),
    bailOnMissing: true,
  });

  const uniquePackageDirs = [
    ...new Set([
      ...toModulePaths(specialCaseEntrypoints.flat(), workspaceRoot),
      ...toModulePaths(specialCaseTraceResult.dependencies, workspaceRoot),
      ...toModulePaths(deps.dependencies, workspaceRoot),
    ]),
  ];

  const externalPaths = new Set<string>(resolvedConfig.extraPaths);

  async function generatePacklistActual(relativeModulePath: string, base: URL) {
    const modulePkgDir = await packageDirectory({
      cwd: join(fileURLToPath(base), relativeModulePath),
    });
    assert(modulePkgDir, 'modulePkgDir empty');

    logger.trace('Creating packlist from %s', modulePkgDir);
    // const manifest = await readPackage({ cwd: modulePkgDir });

    // we only really use globs because we're in our own monorepo
    // and the package may not be published
    const packlist = (
      await Promise.all(
        [
          // just copy everything so we also catch anything new that was installed
          // or generated in lifecycle scripts

          '**/*',
          // ...(manifest.files || ['*']), // no `files[]` -> copy everything
          // ...(manifest.main || []), // add main, as it may not be in `files`
          // ...(manifest.module || []), // add module, as it may not be in `files`
          'package.json',
          'readme*',
          'license*',
        ].map((pattern) =>
          glob.promise(pattern.startsWith('/') ? `.${pattern}` : pattern, {
            cwd: modulePkgDir,
            // NOTE: we can ignore this stuff when adding to the a container image (for example)
            // lockfiles are redundant, we're already *installed*
            // ignore: ['yarn.lock', 'package-lock.json', '**/*.js.map'],
          }),
        ),
      )
    ).flat();

    // logger.info({ tree }, 'tree for %s', moduleName);
    logger.trace({ packlist }, 'packlist for %s', relativeModulePath);

    packlist.forEach((f: string) => {
      const filePath = relative(
        fileURLToPath(workspaceRoot),
        join(modulePkgDir, f),
      );
      externalPaths.add(filePath);
    });
  }

  // eslint-disable-next-line no-restricted-syntax
  for await (const modulePath of [
    // ...(uniquePackageDirs || []),
    // ...(resolvedConfig.externals || []),
    // ...resolvedConfig.extraModules,
    ...uniquePackageDirs,
  ] || []) {
    await generatePacklistActual(modulePath, workspaceRoot);
  }

  await mkdir(outDir, {
    recursive: true,
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  });

  const outDirAsPath = fileURLToPath(outDir);

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

  const builtFilesDest = join(
    outDirAsPath,
    relative(workspaceRootAsPath, fileURLToPath(workingDirectory)),
  );

  logger.trace('Copying built files from %s to %s', buildDir, builtFilesDest);

  // copy build files
  await cp(buildDir, builtFilesDest, { recursive: true });

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of filesWithStat.filter(
    ({ isSymlink }) => !isSymlink,
  )) {
    // logger.info('Copying file %s to %s', file.srcFile, file.destFile);
    await cp(file.srcFile, file.destFile, {
      // errorOnExist: true, // safety first, could be a bug
      recursive: true,
      verbatimSymlinks: true, // node17 only
    }).catch(logger.warn);
  }

  const newPackageJson: PackageJson.PackageJsonStandard = {
    name: packageJson?.name,
    version: packageJson?.version,
    license: packageJson?.license,
    private: packageJson?.private,
    dependencies: packageJson?.dependencies,
    ...(resolvedConfig.sourceType === 'esm' && { type: 'module' }),
    // main: basename(outputFiles[0]),
    // scripts: Object.fromEntries(
    //   Object.entries(packageJson.scripts || {}).filter(([scriptName]) => {
    //     return !scriptName.match(/^(dev|build|test)(\W|$)/);
    //   }),
    // ),
    scripts: Object.fromEntries(
      outputFiles.flatMap(([name, file]) => {
        const scriptName = `${name === 'index' ? 'start' : name}`;
        const scriptPath = join(
          relative(workspaceRootAsPath, fileURLToPath(workingDirectory)),
          relative(buildDir, file),
        );
        return [
          [scriptName, `node ${scriptPath}`],
          [`smoketest-${name}`, `node --check ${scriptPath}`],
        ];
      }),
    ),
    // dependencies: Object.fromEntries(
    //   Array.from(buildResult..entries()).map(([id, { version }]) => [
    //     id,
    //     version,
    //   ]),
    // ),
  };

  // WARN: copy new manifest, this overwrites the one there already
  await writeFile(
    new URL('package.json', outDir),
    JSON.stringify(newPackageJson, null, 2),
  );

  await cleanup().catch((err) => logger.warn(err));

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
