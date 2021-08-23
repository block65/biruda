import { createLogger, Logger } from '@block65/logger';
import chalk from 'chalk';
import * as util from 'util';

interface LogDescriptor {
  level: number;
  msg: string;
  time: number;
  pid: number;
  hostname: string;

  [key: string]: unknown;
}

function formatLevel(level: number) {
  switch (level) {
    case 60: //fatal
      return chalk.whiteBright.bgRed.bold('FATAL');
    case 50: //error
      return chalk.red('ERROR');
    case 40: // warn
      return chalk.yellow('WARN');
    case 30: //info
      return chalk.blue('INFO');
    case 20: //debug
      return chalk.green('DEBUG');
    case 10: //trace
      return chalk.gray('TRACE');
  }
}

export const logger = createLogger({
  prettyPrint: {},
  prettifier(thisArg: Logger, options: unknown) {
    return (log: LogDescriptor) => {
      const { level, msg, time, hostname, pid, ...rest } = log;

      if (msg.startsWith('pino.final with prettyPrint')) {
        return;
      }

      const formattedRest =
        Object.keys(rest).length > 0
          ? util.inspect(rest, {
              colors: true,
            })
          : rest;

      process.stdout.write(
        `${formatLevel(level)}: ${new Date(
          time,
        ).toJSON()} ${msg}${formattedRest}\n`,
      );
      return true;
    };
  },
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  if (lvl !== prevLvl) {
    console.log('%s (%d) was changed to %s (%d)', lvl, val, prevLvl, prevVal);
  }
});
