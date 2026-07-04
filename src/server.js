import express from 'express';
import { pinoHttp } from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import logger from './logger.js';
import healthRoutes from './routes/health.js';
import chatRoutes from './routes/chat.js';
import proposalRoutes from './routes/proposals.js';
import alertRoutes from './routes/alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = config.allowedOrigins;
  // Cross-origin browser access requires an explicit allow-list. When
  // ALLOWED_ORIGINS is unset only same-origin requests work (the bundled UI).
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, X-NaLog-Token'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

export function buildApp({ agent, memory, store }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware);
  // 8mb allows base64 field photos for the Qwen-VL analysis path.
  app.use(express.json({ limit: '8mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  app.use(healthRoutes());
  app.use(chatRoutes({ agent, memory, store }));
  app.use(proposalRoutes({ store, memory }));
  app.use(alertRoutes({ agent }));

  app.use(express.static(PUBLIC_DIR));

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
