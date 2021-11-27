import { createCliLogger } from '@block65/logger';

export const logger = createCliLogger({
  level: 'info',
  // pretty: true,
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
