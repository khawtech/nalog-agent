import config from '../../config.js';
import logger from '../../logger.js';
import LocalStore from './localStore.js';

let instance = null;

export async function getStore() {
  if (instance) return instance;
  if (config.storage.driver === 'alibaba') {
    const { default: TablestoreStore } = await import('./tablestoreStore.js');
    instance = await new TablestoreStore().init();
    logger.info('memory store: Alibaba Cloud Tablestore');
  } else {
    instance = await new LocalStore().init();
    logger.info({ dir: config.storage.dataDir }, 'memory store: local file');
  }
  return instance;
}

export function resetStoreForTests(store) {
  instance = store;
}
