import createLogger from 'pino';
import supportsColor from 'supports-color';

export const logger = createLogger({
  level: 'trace',
  prettyPrint: {
    colorize: !!supportsColor.stdout,
    translateTime: true,
    ignore: 'hostname,pid,time',
  },
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  if (lvl !== prevLvl) {
    console.log('%s (%d) was changed to %s (%d)', lvl, val, prevLvl, prevVal);
  }
});
