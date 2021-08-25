#!/usr/bin/env node
// eslint-disable-next-line import/extensions
import 'source-map-support/register.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { cliBundle } from '../lib/bundle.js';
import { logger } from '../lib/logger.js';
import type { BirudaCliArguments } from '../lib/types.js';

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
yargs(hideBin(process.argv))
  .command<BirudaCliArguments>(
    'bundle',
    'bundle a package',
    (y) => {
      y.option('logLevel', {
        alias: ['l'],
        type: 'string',
        choices: ['trace', 'debug', 'info'],
        description: 'Sets the logging level',
      })
        .option('config', {
          alias: ['c'],
          type: 'string',
          default: 'biruda.config.js',
          description: 'Path to config file',
        })
        .option('outDir', {
          alias: ['o'],
          type: 'string',
          description: 'Name of output bundle file',
        })
        .option('entryPoints', {
          alias: ['e'],
          type: 'array',
          string: true,
          description: 'Entrypoints for bundle',
        })
        .option('externals', {
          alias: ['x'],
          type: 'array',
          string: true,
          description: 'Externals for bundle',
        })
        .option('archiveFormat', {
          alias: ['a'],
          choices: ['tar', 'zip'],
          description: 'Archive format - tar or zip',
        })
        .option('sourceType', {
          alias: ['t'],
          choices: ['esm', 'cjs'],
          description: 'Source type - ES Modules (esm) or CommonJS (cjs)',
        })
        .option('debug', {
          alias: ['d'],
          type: 'boolean',
        })
        .option('compressionLevel', {
          alias: ['z'],
          type: 'number',
          number: true,
          choices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          description:
            'Compression level. 0 is no compress, 9 is best compression',
        })
        .option('extraModules', {
          alias: ['force-include'],
          type: 'array',
          string: true,
          description: 'Force include file paths or modules',
        });
    },
    (argv) => {
      cliBundle(argv).catch((err) => {
        logger.fatal(err);
        process.exitCode = 1;
      });
    },
  )
  .demandCommand(1, 'You need at least one command')
  .strict()
  .help().argv;
