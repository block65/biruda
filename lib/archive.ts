import archiver from 'archiver';
import { createWriteStream, existsSync, lstatSync, realpathSync } from 'fs';
import { dirname, join, relative } from 'path';
import { constants } from 'zlib';
import { logger as parentLogger } from './logger.js';
import { basicThrottle, maybeMakeAbsolute } from './utils.js';

const logger = parentLogger.child({ name: 'archive' });

const regex = /.*?(node_modules.*)/;

function maybeReducePathToNodeModules(path: string, fallback: string): string {
  if (path.match(regex)) {
    return path.replace(regex, '$1');
  }
  logger.warn('%s hit fallback', path);
  return `node_modules/${fallback}`;
}

export async function archiveFiles({
  base,
  pkgDir,
  outDir,
  files = new Set(),
  extras = new Set(),
  format,
  compressionLevel = constants.Z_BEST_SPEED,
}: {
  base: string;
  pkgDir: string;
  outDir: string;
  files: Set<string>;
  extras: Set<string>;
  format: 'zip' | 'tar';
  compressionLevel?: number;
}) {
  logger.info(
    { compressionLevel },
    `Archiving approx %d files and %d extras...`,
    files.size,
    extras.size,
  );

  const isTar = format === 'tar';
  const archive = archiver(
    format,
    isTar
      ? {
          gzip: compressionLevel > 0,
          gzipOptions: {
            level: compressionLevel,
          },
        }
      : { zlib: { level: compressionLevel } },
  );

  // good practice to catch warnings (ie stat failures and other non-blocking errors)
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      logger.warn(/* { err }, */ `Archiver warning: ${err.message}`);
    } else {
      // throw error
      throw err;
    }
  });

  // good practice to catch this error explicitly
  archive.on('error', (err) => {
    logger.error(err, `Archiver error: ${err.message}`);
    archive.abort();
    process.exitCode = 1;
    // throw err;
  });

  archive.on(
    'progress',
    basicThrottle((progress) => {
      logger.trace(
        'Progress: %s of ~%s files archived',
        progress.entries.processed,
        progress.entries.total,
      );
    }, 500),
  );

  const archiveFileName = `pkg.${format}${
    isTar && compressionLevel > 0 ? '.gz' : ''
  }`;
  const output = createWriteStream(`${outDir}/${archiveFileName}`);

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

  // This event is fired when the data source is drained no matter what was the data source.
  // It is not part of this library but rather from the NodeJS Stream API.
  // @see: https://nodejs.org/api/stream.html#stream_event_end
  output.on('end', () => {
    logger.trace('Data has been drained');
  });

  // pipe archive data to the output
  archive.pipe(output);

  logger.trace('Archiving pkgDir %s', pkgDir);
  archive.directory(pkgDir, false);

  logger.trace(`Adding %d files...`, files.size);
  files.forEach((file) => {
    archive.file(join(base, file), {
      name: file,
      // prefix: base,
    });
  });

  logger.trace('Archiving %d extras', extras.size);

  extras.forEach((file) => {
    const looksGlobbish = file.includes('*');
    const absolutePath = maybeMakeAbsolute(file, base);
    const exists = !looksGlobbish && existsSync(absolutePath);

    if (exists) {
      const stats = lstatSync(absolutePath);
      if (stats.isDirectory()) {
        const prefix = maybeReducePathToNodeModules(absolutePath, file);

        logger.trace('Archiving %s into %s (using dir)', file, prefix);
        archive.directory(absolutePath, prefix);
      } else if (stats.isFile()) {
        const prefix = maybeReducePathToNodeModules(absolutePath, file);
        // const prefix = `node_modules/${name}`;

        logger.trace('Archiving %s as %s (using file)', file, prefix);
        archive.file(absolutePath, {
          name: prefix,
        });
      } else if (stats.isSymbolicLink()) {
        // const prefix = maybeReducePathToNodeModules(absolutePath, file);

        // WARN: some weird symlink relativity thing that I dont understand
        // means we need to go up one level before we get the relative
        // otherwise it's off by one
        const symlinkTarget = relative(
          dirname(absolutePath),
          realpathSync(absolutePath),
        );

        logger.trace(
          'Archiving symlink %s -> %s (using symlink)',
          file,
          symlinkTarget,
        );

        archive.symlink(file, symlinkTarget);
      } else {
        logger.warn('Ignored %s. Not a dir or file', file);
      }
    } else if (looksGlobbish) {
      logger.trace('Archiving glob %s (using glob with base %s)', file, base);

      archive.glob(
        file,
        {
          cwd: base,
        },
        {
          // prefix,
        },
      );
    } else {
      logger.trace('File %s doesnt exist and isnt globbish, ignoring', file);
    }
  });

  logger.trace('Finalizing archive');
  return archive.finalize();
}
