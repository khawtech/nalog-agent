import config from './config.js';
import logger from './logger.js';
import { buildApp } from './server.js';
import { AgentService } from './agent/agent.js';
import { MemoryManager } from './memory/memoryManager.js';
import { getStore } from './memory/store/index.js';

async function main() {
  const store = await getStore();
  const memory = await MemoryManager.create();
  const agent = new AgentService(memory, store);

  const app = buildApp({ agent, memory, store });
  // Bind 0.0.0.0 so the Function Compute custom runtime can reach the HTTP server
  // (it probes the configured port). Disable timeouts per FC custom-runtime guidance.
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(
      { port: config.port, env: config.env, storage: config.storage.driver, vector: config.vector.driver },
      'nalog-agent listening'
    );
  });
  server.timeout = 0;
  server.keepAliveTimeout = 0;
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'failed to start');
  process.exit(1);
});
