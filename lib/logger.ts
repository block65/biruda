import createLogger from 'pino';

export const logger = createLogger({
  level: 'info',
  prettyPrint: {
    colorize: true,
    translateTime: true,
  },
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  console.log('%s (%d) was changed to %s (%d)', lvl, val, prevLvl, prevVal);
});
