import createLogger from 'pino';
import supportsColor from 'supports-color';

export const logger = createLogger({
  level: 'info',
  prettyPrint: {
    colorize: supportsColor.stdout,
    translateTime: true,
    ignore: 'hostname,pid',
  },
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  console.log('%s (%d) was changed to %s (%d)', lvl, val, prevLvl, prevVal);
});
