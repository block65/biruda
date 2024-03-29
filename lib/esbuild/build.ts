import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Level } from '@block65/logger';
import esbuild from 'esbuild';
import { dir } from 'tmp-promise';
import ts from 'typescript';
import { logger as parentLogger } from '../logger.js';
import { externalsRegExpPlugin } from './esbuild-plugin-external-wildcard.js';

interface EsBuildOptions {
  entryPoints: Record<string, string>;
  workingDirectory: URL;
  sourceType?: 'esm' | 'cjs';
  debug?: boolean;
  externals?: (string | RegExp)[];
  ignorePackages?: (string | RegExp)[];
  define?: Record<string, string>;
}

export async function build(options: EsBuildOptions): Promise<{
  outputFiles: [entryPointName: string, fileName: string][];
  buildDir: string;
  cleanup: () => Promise<void>;
}> {
  const logger = parentLogger.child({}, { context: { name: 'esbuild' } });

  logger.trace(options, 'build options');

  const { entryPoints, workingDirectory } = options;

  const tsConfigFile = ts.findConfigFile(
    fileURLToPath(workingDirectory),
    ts.sys.fileExists.bind(ts),
    'tsconfig.json',
  );

  if (!tsConfigFile) {
    throw new Error(
      `'Unable to locate tsconfig.json from ${workingDirectory.toString()}'`,
    );
  }

  const tsConfig = ts.readConfigFile(tsConfigFile, ts.sys.readFile.bind(ts));
  const compilerOptions = ts.parseJsonConfigFileContent(
    tsConfig.config,
    ts.sys,
    fileURLToPath(workingDirectory),
  );

  await mkdir(new URL('./tmp', workingDirectory), {
    recursive: true,
  });

  // we need to perform the process inside this directory
  // so we create a tmp file before we move the resulting bundle
  // back out to where the user wanted
  const { path: buildDir, cleanup } = await dir({
    tmpdir: fileURLToPath(workingDirectory),
    dir: './tmp',
    prefix: 'biruda',
    unsafeCleanup: true,
  });

  const clean = () => {
    cleanup().catch(logger.error);
  };

  process.on('beforeExit', clean);
  process.on('exit', clean);

  const externals: (string | RegExp)[] = [
    'node:*', // always skip over internal node modules
    ...(options.ignorePackages || []),
    ...(options.externals || []),
  ];

  const finalEsBuildOptions: esbuild.BuildOptions = {
    absWorkingDir: fileURLToPath(workingDirectory),
    platform: 'node',
    logLevel: logger.level < Level.Info ? 'info' : undefined,
    external: externals.filter((ext): ext is string => typeof ext === 'string'),
    entryPoints,
    outdir: buildDir,
    bundle: true, // dont bundle breaks signed-urls
    minify: !options.debug,
    treeShaking: true,
    color: true,
    target: (compilerOptions.options.target
      ? Object.keys(ts.ScriptTarget)[
          Object.values(ts.ScriptTarget).indexOf(compilerOptions.options.target)
        ]
      : undefined
    )?.toLocaleLowerCase(),
    sourcemap: true,
    sourcesContent: true, // assume we are uploading them to a service like Sentry
    format: options.sourceType || 'esm',
    write: false,
    legalComments: 'none',
    define: options.define,
    banner: {
      js: 'await(async()=>{const{dirname:i}=await import("node:path"),{fileURLToPath:a}=await import("node:url");if(void 0===globalThis.__filename&&(globalThis.__filename=a(import.meta.url)),void 0===globalThis.__dirname&&(globalThis.__dirname=i(globalThis.__filename)),void 0===globalThis.require){const{default:i}=await import("module");globalThis.require=i.createRequire(import.meta.url)}})();',
    },
    plugins: [
      externalsRegExpPlugin({
        externals: externals.filter(
          (ext): ext is RegExp => ext instanceof RegExp,
        ),
      }),
    ],
    metafile: options.debug,
  };
  logger.debug(tsConfig, 'tsconfig parsed');
  logger.debug(finalEsBuildOptions, 'esbuild options');

  logger.info('Building...');

  const buildResult = await esbuild.build(finalEsBuildOptions);

  if (buildResult.warnings.length > 0) {
    logger.info('esbuild warnings: %d', buildResult.warnings.length);

    buildResult.warnings.forEach((warn) => {
      logger.warn(warn, 'esbuild warning: %s', warn.text);
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
          Object.entries(entryPoints).find(
            ([, entryPointFile]) =>
              basename(entryPointFile).replace(/\.[t|j]sx?$/, '') ===
              outputFilePathBasename,
          ) || [];

        if (!entryPointName) {
          logger.warn(
            { entryPoints, outputFilePathBasename, exts },
            'Cant find matching entry point for build output',
          );
          throw new Error('Cant find matching entry point for build output');
        }

        const fileName = `${join(buildDir, entryPointName)}.${exts.join('.')}`;

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

  if (buildResult.metafile) {
    await writeFile(
      join(buildDir, 'meta.json'),
      JSON.stringify(buildResult.metafile, null, 2),
      {
        encoding: 'utf-8',
      },
    );
  }

  logger.info('Build completed');
  logger.debug(`Output is in ${buildDir}`);

  return {
    outputFiles: outputFiles.filter(
      ([, fileName]) => !fileName.endsWith('.map'),
    ),
    buildDir,
    cleanup,
  };
}
