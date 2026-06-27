import express from 'express';
import { pinoHttp } from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import logger from './logger.js';
import healthRoutes from './routes/health.js';
import chatRoutes from './routes/chat.js';
import proposalRoutes from './routes/proposals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = config.allowedOrigins;
  if (!origin || allowed.length === 0 || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || allowed[0] || '*');
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
  app.use(express.json({ limit: '256kb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));

  app.use(healthRoutes());
  app.use(chatRoutes({ agent, memory, store }));
  app.use(proposalRoutes({ store, memory }));

  app.use(express.static(PUBLIC_DIR));

  app.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
