import config from '../../config.js';
import logger from '../../logger.js';
import LocalVector from './localVector.js';

let instance = null;

export async function getVectorStore() {
  if (instance) return instance;
  if (config.vector.driver === 'dashvector') {
    const { default: DashVector } = await import('./dashVector.js');
    instance = await new DashVector().init();
    logger.info('vector store: Alibaba Cloud DashVector');
  } else {
    instance = await new LocalVector().init();
    logger.info('vector store: local cosine index');
  }
  return instance;
}

export function resetVectorForTests(store) {
  instance = store;
}
