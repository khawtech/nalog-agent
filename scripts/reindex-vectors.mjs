// Re-embed all episodic memories from the store into DashVector.
// Use after provisioning a fresh DashVector cluster or rotating embedding models.
//
// Usage:
//   npm run reindex:vectors
//   npm run reindex:vectors -- --dry-run
//   npm run reindex:vectors -- --farmer-id farmer-somchai
import 'dotenv/config';
import config from '../src/config.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import logger from '../src/logger.js';

function parseArgs(argv) {
  const opts = { dryRun: false, farmerId: null, batchSize: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--farmer-id') opts.farmerId = argv[++i] || null;
    else if (arg === '--batch-size') opts.batchSize = Number(argv[++i]) || opts.batchSize;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/reindex-vectors.mjs [options]

Options:
  --dry-run            Count memories without embedding or upserting
  --farmer-id <id>     Reindex one farmer only
  --batch-size <n>     Embedding batch size (default: 10, DashScope max)
  -h, --help           Show this help

Requires STORAGE_DRIVER=alibaba and VECTOR_DRIVER=dashvector (or local for dev).
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  if (!config.dashscope.apiKey && !opts.dryRun) {
    throw new Error('DASHSCOPE_API_KEY is required for embedding (use --dry-run to inspect counts only)');
  }

  const memory = await MemoryManager.create();
  logger.info(
    {
      storage: config.storage.driver,
      vector: config.vector.driver,
      farmerId: opts.farmerId || 'all',
      dryRun: opts.dryRun,
      batchSize: opts.batchSize,
    },
    'starting vector reindex'
  );

  const result = await memory.reindexVectors({
    farmerId: opts.farmerId,
    dryRun: opts.dryRun,
    batchSize: opts.batchSize,
  });

  console.log(
    `Done: ${result.indexed}/${result.total} indexed` +
      (result.failed ? `, ${result.failed} failed` : '') +
      (result.skipped ? `, ${result.skipped} skipped (empty/superseded/expired)` : '')
  );
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'vector reindex failed');
  process.exit(1);
});
