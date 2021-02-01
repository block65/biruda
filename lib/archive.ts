import archiver from 'archiver';
import { createWriteStream, existsSync, lstatSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { constants } from 'zlib';
import { logger } from './logger';
import { Dependency } from './deps';
import { basicThrottle } from './utils';

function maybeReducePathToNodeModules(path: string, fallback: string): string {
  const regex = /.*?(node_modules.*)/;
  if (path.match(regex)) {
    return path.replace(regex, '$1');
  }
  return `node_modules/${fallback}`;
}

export async function archiveFiles({
  base,
  pkgDir,
  outDir,
  pkgFiles = [],
  files = [],
  extraGlobDirs = [],
  format = 'tar',
}: {
  base: string;
  pkgDir: string;
  outDir: string;
  pkgFiles?: string[];
  files?: string[];
  extraGlobDirs?: string[];
  format?: 'zip' | 'tar';
}) {
  const isTar = format === 'tar';
  const archive = archiver(
    format,
    isTar
      ? {
          gzip: true,
          gzipOptions: {
            level: -1,
          },
        }
      : { zlib: { level: constants.Z_BEST_SPEED } },
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
        'Progress: %s of %s files archived',
        progress.entries.processed,
        progress.entries.total,
      );
    }, 500),
  );

  const archiveFileName = `pkg.${format}${isTar ? '.gz' : ''}`;
  const output = createWriteStream(`${outDir}/${archiveFileName}`);

  // listen for all archive data to be written
  // 'close' event is fired only when a file descriptor is involved
  output.on('close', () => {
    logger.info(
      `Archive is ~${new Intl.NumberFormat().format(
        Math.round(archive.pointer() / 1024),
      )}kb`,
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

  logger.trace('Adding pkgDir %s', pkgDir);
  archive.directory(pkgDir, false);

  logger.trace({ pkgFiles }, 'Adding %d extra pkgFiles', pkgFiles.length);

  pkgFiles.forEach((file) => {
    archive.file(join(base, file), {
      name: basename(file),
      // prefix: base,
    });
  });

  logger.trace(
    // { extraGlobDirs },
    'Adding %d extra dirs via glob',
    extraGlobDirs.length,
  );

  extraGlobDirs.forEach((dir) => {
    archive.glob(
      '**/*',
      {
        cwd: dir,
      },
      {
        prefix: relative(base, dir),
      },
    );
  });

  logger.info(`Adding %d files...`, files.length);
  files.forEach((file) => {
    archive.file(join(base, file), {
      name: file,
      // prefix: base,
    });
  });

  logger.trace('Finalizing archive');
  return archive.finalize();
}

export async function archiveDependencies({
  dependencies,
  pkgDir,
  outDir,
  format = 'tar',
}: {
  dependencies: Dependency[];
  pkgDir: string;
  outDir: string;
  format?: 'zip' | 'tar';
}) {
  const isTar = format === 'tar';
  const archive = archiver(
    format,
    isTar
      ? {
          gzip: true,
          gzipOptions: {
            level: -1,
          },
        }
      : { zlib: { level: constants.Z_BEST_SPEED } },
  );

  const archiveFileName = `pkg.${format}${isTar ? '.gz' : ''}`;

  archive.glob('**/*', {
    cwd: pkgDir,
  });

  // good practice to catch warnings (ie stat failures and other non-blocking errors)
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      logger.warn({ err }, err.message);
    } else {
      // throw error
      throw err;
    }
  });

  // good practice to catch this error explicitly
  archive.on('error', (err) => {
    logger.error(err, 'Archiver error');
    archive.abort();
    process.exitCode = 1;
    // throw err;
  });

  archive.on(
    'progress',
    basicThrottle((progress) => {
      logger.trace(
        'Progress: %s of %s entries archived',
        progress.entries.processed,
        progress.entries.total,
      );
    }, 300),
  );

  const output = createWriteStream(`${outDir}/${archiveFileName}`);

  // listen for all archive data to be written
  // 'close' event is fired only when a file descriptor is involved
  output.on('close', () => {
    logger.info(
      `Archive is ~${new Intl.NumberFormat().format(
        Math.round(archive.pointer() / 1024),
      )}kb`,
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

  logger.trace('Piping archiver into output');
  // pipe archive data to the output
  archive.pipe(output);

  logger.trace('Archiving dependencies');

  dependencies.forEach(({ path, name, files, version }) => {
    // const moduleBasePathForArchive = join('node_modules', name);

    const id = `${name}@${version}`;

    if (!files) {
      const destPath = maybeReducePathToNodeModules(path, name);
      logger.trace('[%s] No files[]. Archiving %s into %s', id, path, destPath);
      // archive.directory(path, destPath);
      archive.glob(
        `**/*`,
        {
          cwd: path,
          debug: true,
          ignore: ['node_modules', '*.tsbuildinfo'],
        },
        {
          prefix: destPath,
        },
      );
      return;
    }

    const pkgJsonPrefix = maybeReducePathToNodeModules(path, name);

    // add the package.json
    logger.debug(
      { path },
      '[%s] Archiving package.json into %s',
      id,
      pkgJsonPrefix,
    );

    archive.file(resolve(path, 'package.json'), {
      name: 'package.json',
      prefix: pkgJsonPrefix,
    });

    files
      ?.filter((file) => file !== 'package.json') // we already added it
      .forEach((entry) => {
        // archive.glob(resolve(basePath, file));

        const absoluteFilePath = join(path, entry);
        const looksGlobbish = absoluteFilePath.includes('*');
        const exists = !looksGlobbish && existsSync(absoluteFilePath);

        if (exists) {
          const stats = lstatSync(absoluteFilePath);
          if (stats.isDirectory()) {
            const prefix = maybeReducePathToNodeModules(absoluteFilePath, name);

            logger.debug(
              '[%s] Archiving %s into %s (using dir)',
              id,
              entry,
              prefix,
            );
            // logger.trace({ absoluteFilePath }, 'directory');
            archive.directory(absoluteFilePath, prefix);
          } else if (stats.isFile()) {
            const prefix = maybeReducePathToNodeModules(absoluteFilePath, name);
            // const prefix = `node_modules/${name}`;

            logger.debug(
              '[%s] Archiving %s as %s (using file)',
              id,
              entry,
              prefix,
            );
            // logger.trace({ absoluteFilePath }, 'file');
            archive.file(absoluteFilePath, {
              name: prefix,
            });
          }
        } else {
          if (!looksGlobbish) {
            logger.warn('File %s doesnt exist, trying glob instead', entry);
          }

          const prefix = maybeReducePathToNodeModules(path, name);
          // const prefix = `node_modules/${name}`;

          logger.debug(
            '[%s] Archiving %s into %s (using glob)',
            id,
            entry,
            prefix,
          );
          // logger.trace({ absoluteFilePath, exists, path, entry }, 'glob');

          // if "file" doesnt exist, it might be a glob. Try it.
          archive.glob(
            entry,
            {
              cwd: path,
            },
            {
              prefix,
            },
          );
        }

        // logger.trace({ basePath, file, resolved: resolve(basePath, file) });
      });
  });

  logger.trace('Finalizing archive');
  return archive.finalize();
}
