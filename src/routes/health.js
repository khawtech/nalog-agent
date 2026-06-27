import { Router } from 'express';
import config from '../config.js';
import { nalogMode } from '../integrations/nalog.js';

export default function healthRoutes() {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'nalog-agent',
      nalogMode: nalogMode(),
      storage: config.storage.driver,
      vector: config.vector.driver,
      models: config.dashscope.models,
      time: new Date().toISOString(),
    });
  });

  return router;
}
