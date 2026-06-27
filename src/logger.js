import pino from 'pino';
import config from './config.js';

const isDev = config.env === 'development';

const logger = pino({
  level: config.logLevel,
  base: { service: 'nalog-agent' },
  redact: {
    paths: [
      'req.headers.authorization',
      'apiKey',
      'token',
      '*.apiKey',
      '*.accessKeySecret',
    ],
    censor: '[redacted]',
  },
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});

export default logger;
