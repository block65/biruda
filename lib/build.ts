import type { PackageJson, TsConfigJson } from 'type-fest';
import * as esbuild from 'esbuild';
import { lstatSync, statSync, writeFileSync } from 'fs';
import { dir } from 'tmp-promise';
import pkgUp from 'pkg-up';
import { dirname, resolve } from 'path';
import { logger } from './logger';

// all optional because they might be on command like
export interface BirudaConfigFileProperties {
  entryPoints?: string[];
  verbose?: boolean;
  outDir?: string;
  platform?: string;
  externals?: string[];
  forceInclude?: string[];
  ignorePackages?: string[];
  archiveFormat?: 'zip' | 'tar';
  sourceMapSupport?: boolean;
}

export interface BirudaCliArguments {
  config?: string;
  verbose?: boolean;
  output?: string;
  // baseDir?: string;
  entrypoint?: string[];
  archiveFormat?: string;
  forceInclude?: string[];
  sourceMapSupport?: boolean;
}

export interface BirudaBuildOptions {
  verbose?: boolean;
  outDir: string;
  entryPoint: string;
  // baseDir: string;
  platform: string;
  externals?: string[];
  ignorePackages?: string[];
  forceInclude?: string[];
  sourceMapSupport?: boolean;
}

export async function build(
  options: BirudaBuildOptions,
): Promise<{ tmpFile: string; tmpDir: string; cleanup: () => Promise<void> }> {
  const { entryPoint } = options;

  const entryPointStat = statSync(entryPoint);
  if (!entryPointStat.isFile()) {
    throw new Error(`Invalid entrypoint ${entryPoint}`);
  }

  // eslint-disable-next-line global-require,import/no-dynamic-require
  // const packageJson: PackageJson = require(resolve(baseDir, 'package.json'));
  const packageJsonPath = await pkgUp({
    cwd: dirname(entryPoint),
  });

  if (!packageJsonPath) {
    throw new Error('Cant find a package.json');
  }

  // eslint-disable-next-line global-require,import/no-dynamic-require
  const packageJson: PackageJson = require(packageJsonPath);

  // eslint-disable-next-line global-require,import/no-dynamic-require
  const tsConfigJson: TsConfigJson = require(resolve(
    dirname(packageJsonPath),
    'tsconfig.json',
  ));

  // we need to perform the process inside this directory
  // so we create a tmp file before we move the resulting bundle
  // back out to where the user wanted
  const { path: tmpDir, cleanup } = await dir({
    tmpdir: dirname(entryPoint),
    template: '.tmp-biruda-XXXXXX',
    unsafeCleanup: true,
  });

  // process.on('beforeExit', cleanup);

  const esBuildOutputFilePath = resolve(tmpDir, 'index.js');

  const finalEsBuildOptions: esbuild.BuildOptions = {
    platform: options.platform === 'browser' ? 'browser' : 'node',
    logLevel: options.verbose ? 'info' : 'error',
    external: [...(options.ignorePackages || []), ...(options.externals || [])],
    entryPoints: [entryPoint], // [maybeMakeAbsolute(entryPoint, baseDir)],
    outfile: esBuildOutputFilePath,
    // metafile: '/tmp/meta.json',
    bundle: true,
    minify: false,
    color: true,
    target: tsConfigJson.compilerOptions?.target,
    sourcemap: true, // 'external',
    errorLimit: 1,
    define: {
      NODE_ENV: 'production',
    },
  };

  logger.info('Building entryPoints %s ...', entryPoint);

  return esbuild.build(finalEsBuildOptions).then(async (buildResult) => {
    if (buildResult.warnings.length > 0) {
      logger.warn('Build warnings: %d', buildResult.warnings.length);

      buildResult.warnings.forEach((warn) => {
        logger.trace(warn, `Warning: ${warn.text}`);
      });
    }

    const newPackageJson: PackageJson.PackageJsonStandard = {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
      private: packageJson.private,
      // main: path.basename(entryPoint),
      // scripts: Object.fromEntries(
      //   Object.entries(packageJson.scripts || {}).filter(([scriptName]) => {
      //     return !scriptName.match(/^(dev|build|test)(\W|$)/);
      //   }),
      // ),
      // scripts: {
      //   start: 'node index.js',
      // },
      // dependencies: Object.fromEntries(
      //   Array.from(dependencies.entries()).map(([id, { version }]) => [
      //     id,
      //     version,
      //   ]),
      // ),
    };

    const stat = lstatSync(esBuildOutputFilePath);

    if (stat.size === 0) {
      logger.warn(`Empty output file`);
      logger.trace({ stat }, `Stat file %s`, esBuildOutputFilePath);
      throw new Error('Empty output file');
    }

    // const absoluteOutputFile = maybeMakeAbsolute('index.js', tmpDir);
    // copyFileSync(esBuildOutputFilePath, absoluteOutputFile);
    // logger.warn(
    //   {
    //     stat: lstatSync(esBuildOutputFilePath),
    //     esBuildOutputFilePath,
    //     absoluteOutputFile,
    //   },
    //   `Stat file %s after:copyFileSync0`,
    // );
    // copyFileSync(`${esBuildOutputFilePath}.map`, `${absoluteOutputFile}.map`);

    writeFileSync(
      resolve(tmpDir, 'package.json'),
      JSON.stringify(newPackageJson, null, 2),
    );
    logger.info(`Build completed. Output is in ${tmpDir}`);

    return { tmpFile: esBuildOutputFilePath, tmpDir, cleanup };
  });
  // .catch((err) => logger.error(err));
}
