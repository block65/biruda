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
  .command(
    'bundle',
    'bundle a package',
    (y) => {
      y.option('verbose', {
        alias: ['v'],
        type: 'boolean',
        default: false,
        description: 'Run with verbose logging',
      })
        .option('config', {
          alias: ['c'],
          type: 'string',
          default: 'biruda.config.js',
          description: 'Path to config file',
        })
        .option('output', {
          alias: ['o'],
          type: 'string',
          description: 'Name of output bundle file',
        })
        .option('entrypoint', {
          alias: ['e'],
          type: 'array',
          string: true,
          description: 'Entrypoint for bundle',
        })
        .option('archiveFormat', {
          alias: ['a'],
          choices: ['tar', 'zip'],
          default: 'tar',
          description: 'Archive format - tar or zip',
        })
        .option('compressionLevel', {
          alias: ['z'],
          type: 'number',
          number: true,
          choices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
          description:
            'Compression level. 0 is no compress, 9 is best compression',
        })
        .option('forceInclude', {
          alias: ['force-include'],
          type: 'array',
          string: true,
          description: 'Force include file paths or modules',
        });
    },
    (argv) => {
      if (argv.verbose) {
        logger.info(`bundle starting`, argv.argv);
      }

      cliBundle(argv as BirudaCliArguments).catch((err) => {
        logger.error(err);
        process.exitCode = 1;
      });
    },
  )
  .demandCommand(1, 'You need at least one command')
  .strict()
  .help().argv;
