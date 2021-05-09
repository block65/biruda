import { logger } from './logger';

async function main() {
  //
  logger.log('finding files...');
}

main().then(logger.info).catch(logger.error);
