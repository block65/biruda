import { createLogger } from '@block65/logger';

export const logger = createLogger({
  level: 'debug',
});

logger.on('level-change', (lvl, val, prevLvl, prevVal) => {
  if (lvl !== prevLvl) {
    logger.debug(
      'Logger level %s (%d) was changed to %s (%d)',
      prevLvl,
      prevVal,
      lvl,
      val,
    );
  }
});
