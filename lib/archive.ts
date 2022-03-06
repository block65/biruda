import archiver from 'archiver';
import fs, { createWriteStream } from 'fs';
import { access, lstat, realpath } from 'fs/promises';
import glob from 'glob';
import { dirname, join, relative } from 'path';
import { fileURLToPath, URL } from 'url';
import { constants } from 'zlib';
import { logger as parentLogger } from './logger.js';
import { basicThrottle, maybeMakeAbsolute } from './utils.js';

const logger = parentLogger.child({ name: 'archive' });

// const regex = /.*?(node_modules.*)/;

// function maybeReducePathToNodeModules(path: string, fallback: string): string {
//   if (path.match(regex)) {
//     return path.replace(regex, '$1');
//   }
//   logger.warn('%s hit fallback', path);
//   return `node_modules/${fallback}`;
// }

export async function archiveFiles({
  workspaceRoot,
  bundleSource,
  bundleDest,
  outDir,
  files = new Set(),
  extras = new Set(),
  format,
  compressionLevel = constants.Z_BEST_SPEED,
}: {
  workspaceRoot: URL;
  bundleSource: string;
  bundleDest: string;
  outDir: URL;
  files: Set<string>;
  extras: Set<string>;
  format: 'zip' | 'tar';
  compressionLevel?: number;
}): Promise<{ bytesWritten: number; path: URL }> {
  logger.info(
    { compressionLevel },
    `Archiving approx %d files and %d extras...`,
    files.size,
    extras.size,
  );

  const base = fileURLToPath(workspaceRoot);

  const isTar = format === 'tar';
  const archive = archiver(format, {
    ...(isTar
      ? {
          gzip: compressionLevel > 0,
          gzipOptions: {
            level: compressionLevel,
          },
        }
      : { zlib: { level: compressionLevel } }),
    statConcurrency: 1, // guaranteed order,
  });

  // it's good practise to catch warnings (ie stat failures and
  // other non-blocking errors)
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      logger.warn(/* { err }, */ `Archiver warning: ${err.message}`);
    } else {
      // throw error
      throw err;
    }
  });

  // good practise to catch this error explicitly
  archive.on('error', (err) => {
    logger.error(err, `Archiver error: ${err.message}`);
    archive.abort();
    process.exitCode = 1;
    // throw err;
  });

  archive.on(
    'progress',
    basicThrottle((progress) => {
      logger.info(
        'Progress: %s of ~%s files archived',
        progress.entries.processed,
        progress.entries.total,
      );
    }, 1000),
  );

  const archiveFileName = `pkg.${format}${
    isTar && compressionLevel > 0 ? '.gz' : ''
  }`;
  const archivePath = new URL(archiveFileName, outDir);
  const output = createWriteStream(archivePath);

  // listen for all archive data to be written
  // 'close' event is fired only when a file descriptor is involved
  output.on('close', () => {
    logger.info(
      `Archive is ~%skb`,
      new Intl.NumberFormat().format(Math.round(archive.pointer() / 1024)),
    );
    logger.trace(
      'Archiver has been finalized and the output file descriptor has closed.',
    );
  });

  // let entryCount = 0;
  // archive.on('entry', (entry) => {
  //   entryCount += 1;
  //   logger.info('entry %d: %s', entryCount, entry.name);
  // });

  // pipe archive data to the output
  archive.pipe(output);

  // archive.on('entry', () => {});

  logger.trace('Archiving pkgDir %s into %s', bundleSource, bundleDest);
  archive.directory(bundleSource, bundleDest);

  logger.debug(/* Array.from(files), */ `Adding %d files...`, files.size);
  files.forEach((file) => {
    // exclude the original package.json, we added it above into the workingModuleDir
    if (file === join(bundleDest, 'package.json')) {
      return;
    }
    // logger.trace('archive.file %s {name:%s}', join(base, file), file);

    archive.file(join(base, file), {
      name: file,
      // prefix: base,
    });
  });

  logger.debug(Array.from(extras), 'Archiving %d extras', extras.size);

  // eslint-disable-next-line no-restricted-syntax
  for await (const path of extras) {
    const absolutePath = maybeMakeAbsolute(path, base);

    const exists = await access(absolutePath, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false);
    const looksGlobbish = path.includes('*');

    // logger.debug('absolutePath: %s - exists: %s', absolutePath, exists);

    if (exists) {
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        // const prefix = maybeReducePathToNodeModules(absolutePath, file);
        //
        // if (file !== prefix) {
        //   logger.warn({ file, prefix, absolutePath });
        // }

        logger.debug('Archiving %s (using dir)', path);
        archive.directory(absolutePath, path /* , prefix */, {});
      } else if (stats.isFile()) {
        // const prefix = maybeReducePathToNodeModules(absolutePath, file);
        // const prefix = `node_modules/${name}`;
        //
        // if (file !== prefix) {
        //   logger.warn({ file, prefix, absolutePath });
        // }

        logger.debug('Archiving %s (using file)', path /* , prefix */);
        archive.file(absolutePath, {
          name: path,
        });
      } else if (stats.isSymbolicLink()) {
        // const prefix = maybeReducePathToNodeModules(absolutePath, file);

        // WARN: some weird symlink relativity thing that I dont understand
        // means we need to go up one level before we get the relative
        // otherwise it's off by one
        const symlinkTarget = relative(
          dirname(absolutePath),
          await realpath(absolutePath),
        );

        logger.debug(
          'Archiving symlink %s -> %s (using symlink)',
          absolutePath,
          symlinkTarget,
        );

        archive.symlink(absolutePath, symlinkTarget);
      } else {
        logger.warn('Ignored %s. Not a dir or file', absolutePath);
      }
    } else if (looksGlobbish) {
      logger.trace('Archiving %s (using glob with base %s)', path, base);

      // NOTE: Archivers own glob is sloowwwwww, so we use our own
      await new Promise<void>((resolve, reject) => {
        glob(
          path,
          {
            debug: logger.levelVal < 30,
            cwd: base,
            absolute: true,
          },
          function (err, globFiles) {
            if (err) {
              return reject(err);
            }

            logger.trace(
              'Archiving %d files (via glob %s)',
              globFiles.length,
              path,
            );

            globFiles.forEach((f) =>
              archive.file(f, {
                name: relative(fileURLToPath(workspaceRoot), f),
              }),
            );
            resolve();
          },
        );
      });

      // archive.glob(
      //   absolutePath,
      //   {
      //     cwd: base,
      //   },
      //   {
      //     // prefix,
      //   },
      // );
    } else {
      logger.warn('Ignored %s. doesnt exist', absolutePath);
    }
  }

  await new Promise(async (resolve) => {
    logger.trace('Finalizing archive');
    await archive.finalize();

    output.on('close', resolve);
  });

  return { bytesWritten: archive.pointer(), path: archivePath };
}
