// Seed the memory store with the demo farmer's profile and prior-season
// experience, so the agent starts with something to recall.
// Usage: npm run seed
import { MemoryManager } from '../src/memory/memoryManager.js';
import {
  DEMO_FARMER,
  DEMO_PROFILE_FACTS,
  DEMO_SEED_MEMORIES,
} from '../src/integrations/demoData.js';
import logger from '../src/logger.js';

async function main() {
  const memory = await MemoryManager.create();
  const farmerId = DEMO_FARMER.farmerId;

  for (const fact of DEMO_PROFILE_FACTS) {
    await memory.setProfileFact(farmerId, fact.key, fact.value, fact.confidence);
  }

  // Backdate seed memories so recency/decay behaves realistically.
  for (const [i, m] of DEMO_SEED_MEMORIES.entries()) {
    const mem = await memory.recordEpisodic({
      farmerId,
      paddyId: m.paddyId,
      type: m.type,
      text: m.text,
      structured: m.structured,
    });
    // Push createdAt back 60..240 days to simulate prior seasons.
    mem.createdAt = new Date(Date.now() - (60 + i * 60) * 86_400_000).toISOString();
    await memory.store.putEpisodic(mem);
  }

  logger.info(
    { farmerId, facts: DEMO_PROFILE_FACTS.length, memories: DEMO_SEED_MEMORIES.length },
    'demo memory seeded'
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'seed failed');
  process.exit(1);
});
