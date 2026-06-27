// Provisions Alibaba Cloud storage for the agent:
//   - Tablestore tables (with TTL on episodic memory)
//   - DashVector collection (semantic memory index)
// Run once before first deploy:  node deploy/provision.js
import config from '../src/config.js';
import logger from '../src/logger.js';

async function main() {
  if (config.storage.driver === 'alibaba') {
    const { default: TablestoreStore } = await import('../src/memory/store/tablestoreStore.js');
    const ts = new TablestoreStore();
    await ts.provisionTables();
  } else {
    logger.info('STORAGE_DRIVER is not "alibaba" — skipping Tablestore provisioning');
  }

  if (config.vector.driver === 'dashvector') {
    const { default: DashVector } = await import('../src/memory/vector/dashVector.js');
    const dv = new DashVector();
    await dv.provisionCollection();
  } else {
    logger.info('VECTOR_DRIVER is not "dashvector" — skipping DashVector provisioning');
  }

  logger.info('provisioning complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'provisioning failed');
  process.exit(1);
});
