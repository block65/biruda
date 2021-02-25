#!/usr/bin/env node
import 'source-map-support/register';
import yargs from 'yargs';
// @ts-ignore
import { hideBin } from 'yargs/helpers';
import { logger } from '../lib/logger';
import { cliBundle } from '../lib/bundle';

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
yargs(hideBin(process.argv))
  .option('verbose', {
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
    type: 'string',
    string: true,
    description: 'Archive format - tar or zip',
  })
  .command(
    'bundle',
    'bundle a package',
    // (y) => {
    //   return y.positional('port', {
    //     describe: 'port to bind on',
    //     default: 5000,
    //   });
    // },
    async ({ argv }) => {
      if (argv.verbose) {
        logger.info(`bundle starting`, argv);
      }

      return cliBundle(argv).catch((err) => {
        logger.error(err.stack);
        process.exitCode = 1;
      });
    },
  )
  .demandCommand(1, 'You need at least one command')
  .help().argv;
