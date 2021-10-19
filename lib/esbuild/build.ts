import * as esbuild from 'esbuild';
import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { dir } from 'tmp-promise';
import type { TsConfigJson } from 'type-fest';
import { fileURLToPath, URL } from 'url';
import { logger as parentLogger } from '../logger.js';
import { readJsonFile } from '../utils.js';
import { externalsRegExpPlugin } from './esbuild-plugin-external-wildcard.js';

const logger = parentLogger.child({ name: 'esbuild' });

interface EsBuildOptions {
  entryPoints: Record<string, string>;
  workingDirectory: URL;
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
}

export async function build(options: EsBuildOptions): Promise<{
  outputFiles: [entryPointName: string, fileName: string][];
  outputDir: string;
  // tsConfigJson: TsConfigJson;
  // packageJson: PackageJson;
  cleanup: () => Promise<void>;
}> {
  logger.trace(options, 'build options');

  const { entryPoints, workingDirectory } = options;

  // const packageJsonUrl = pathToFileURL(packageJsonPath);

  // const packageJson = await readManifest(packageJsonUrl);

  const tsConfigJson = await readJsonFile<TsConfigJson>(
    new URL('./tsconfig.json', workingDirectory),
  ).catch((err): TsConfigJson => {
    logger.warn({ workingDirectory, err }, err.message);
    return {};
  });

  await mkdir(new URL('./tmp', workingDirectory), {
    recursive: true,
  });

  // we need to perform the process inside this directory
  // so we create a tmp file before we move the resulting bundle
  // back out to where the user wanted
  const { path: outputDir, cleanup } = await dir({
    tmpdir: fileURLToPath(workingDirectory),
    dir: './tmp',
    prefix: 'biruda',
    unsafeCleanup: true,
  });

  const clean = () => cleanup().catch((err) => console.warn(err));

  process.on('beforeExit', clean);
  process.on('exit', clean);

  const externals: (string | RegExp)[] = [
    'node:*', // always skip over internal node modules
    ...(options.ignorePackages || []),
    ...(options.externals || []),
  ];

  // logger.debug({ externals }, 'Resolved externals');

  // const esBuildOutputFilePath = resolve(tmpDir, 'index.js');

  const finalEsBuildOptions: esbuild.BuildOptions = {
    platform: 'node',
    logLevel: logger.levelVal < 30 ? 'info' : undefined,
    external: externals.filter((ext): ext is string => typeof ext === 'string'),
    entryPoints,
    outdir: outputDir,
    bundle: true,
    minify: !options.debug,
    treeShaking: true,
    color: true,
    target: tsConfigJson.compilerOptions?.target,
    sourcemap: 'external',
    sourcesContent: false, // unlikely to attach a debugger in production node
    format: 'esm' || options.sourceType,
    write: false,
    define: {
      NODE_ENV: 'production',
    },
    plugins: [
      externalsRegExpPlugin({
        externals: externals.filter(
          (ext): ext is RegExp => ext instanceof RegExp,
        ),
      }),
    ],
    // metafile: '/tmp/meta.json',
    // absWorkingDir: dirname(entryPoint),
    // errorLimit: 1,
  };

  logger.trace(finalEsBuildOptions, 'finalEsBuildOptions');

  logger.debug('Building with esbuild...');

  const buildResult = await esbuild.build(finalEsBuildOptions);

  if (buildResult.warnings.length > 0) {
    logger.info('Build warnings: %d', buildResult.warnings.length);

    buildResult.warnings.forEach((warn) => {
      logger.warn(warn, `Warning: ${warn.text}`);
    });
  }

  if (!buildResult.outputFiles) {
    throw new Error('Missing outputFiles from build result');
  }

  const outputFiles = await Promise.all(
    buildResult.outputFiles.map(
      async (
        outputFile,
      ): Promise<[entryPointName: string, fileName: string]> => {
        const [outputFilePathBasename, ...exts] = basename(
          outputFile.path,
        ).split(/\./);

        // find the entrypoint that matches this output file
        const [entryPointName /* , entryPointFileForOutput */] =
          Object.entries(entryPoints).find(([, entryPointFile]) => {
            return (
              basename(entryPointFile).replace(/\.[t|j]s$/, '') ===
              outputFilePathBasename
            );
          }) || [];

        if (!entryPointName) {
          logger.warn({ entryPoints, outputFilePathBasename, exts });
          throw new Error('Cant find matching entry point for build output ');
        }

        const fileName = `${join(outputDir, entryPointName)}.${exts.join('.')}`;

        // archiver finalize() exits without error if the outDir doesnt exist
        await mkdir(dirname(fileName), {
          recursive: true,
        });

        await writeFile(fileName, outputFile.contents, {
          encoding: 'utf-8',
        });

        return [entryPointName, fileName];
      },
    ),
  );

  logger.info(`Build completed. Output is in ${outputDir}`);

  return {
    outputFiles: outputFiles.filter(
      ([, fileName]) => !fileName.endsWith('.map'),
    ),
    outputDir,
    cleanup,
  };
}
