import { createLogger, Logger } from '@block65/logger';
import chalk from 'chalk';
import * as util from 'util';

interface LogDescriptor {
  level: number;
  msg?: string;
  name?: string | undefined;
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
  level: 'trace',
  prettyPrint: {},
  prettifier(thisArg: Logger, options: unknown) {
    return (log: LogDescriptor) => {
      const { level, msg = '', time, name, hostname, pid, ...rest } = log;

      if (msg?.startsWith('pino.final with prettyPrint')) {
        return '';
      }

      const formattedName = name ? `(${name})` : '';
      const formattedMsg = msg && ' ' + chalk.whiteBright(msg);

      const formattedRest =
        Object.keys(rest).length > 0
          ? ' ' +
            util.inspect(rest, {
              colors: true,
              compact: true,
              sorted: true,
            })
          : '';

      return `${formatLevel(level)}${formattedName}: ${chalk.gray(
        new Date(time).toJSON(),
      )}${formattedMsg}${formattedRest}\n`;
    };
  },
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  if (lvl !== prevLvl) {
    logger.info(
      'Logger level %s (%d) was changed to %s (%d)',
      prevLvl,
      prevVal,
      lvl,
      val,
    );
  }
});
