import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { logger } from './logger.js';
import { startCronJob, stopCronJob, runNow, getCronStatus } from './cronJob.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let openapiSpec = {};
try {
  openapiSpec = JSON.parse(readFileSync(path.join(__dirname, 'openapi.json'), 'utf-8'));
} catch (err) {
  logger.error('Failed to load openapi.json — API docs disabled, server continues', err);
}
const app = express();
const PORT = process.env.PORT || 3000;

const CORS_ORIGIN = process.env.CORS_ORIGIN || false;

if (CORS_ORIGIN) {
  app.use(cors({ origin: CORS_ORIGIN }));
} else {
  app.use(cors());
}

// Optional shared secret: x-api-key required on /api/cron/*
const API_KEY = process.env.API_KEY || '';
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const expected = Buffer.from(API_KEY);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  logger.warn('Rejected request with missing/invalid API key', { path: req.path, ip: req.ip });
  return sendError(res, 401, 'Missing or invalid API key', { code: 'UNAUTHORIZED' });
}
app.use('/api/cron', requireApiKey);
if (!API_KEY) {
  logger.warn('API_KEY is not set — /api/cron/* is UNAUTHENTICATED. Set API_KEY in .env or restrict the port with a firewall.');
}

/** Forwards a rejected async handler to the Express error middleware */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function sendSuccess(res, data, status = 200) {
  res.status(status).json({ success: true, data, error: null });
}

function sendError(res, status, message, { code } = {}) {
  res.status(status).json({ success: false, data: null, error: { message, code: code ?? null } });
}

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'Outlook Attachment Pipeline API' }));
app.get('/api-docs.json', (_req, res) => res.json(openapiSpec));

app.get('/api/health', (_req, res) => {
  sendSuccess(res, { ok: true });
});

/** GET /api/cron/status */
app.get('/api/cron/status', (_req, res) => {
  sendSuccess(res, getCronStatus());
});

/** POST /api/cron/run-now */
app.post('/api/cron/run-now', asyncRoute(async (_req, res) => {
  try {
    const result = await runNow();
    if (result?.skipped) {
      return sendError(res, 409, 'A cron run is already in progress', { code: 'CRON_BUSY' });
    }
    sendSuccess(res, result);
  } catch (err) {
    sendError(res, 502, err.message, { code: 'CRON_RUN_FAILED' });
  }
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  logger.error('Unexpected server error', { path: req.path, method: req.method, error: err });
  sendError(res, 500, 'Unexpected server error', { code: 'INTERNAL_ERROR' });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (process kept alive)', {
    reason: reason instanceof Error ? reason : String(reason),
  });
});

// Set EXIT_ON_UNCAUGHT=true to restore "log, then exit and let PM2/systemd restart" behaviour
const EXIT_ON_UNCAUGHT = process.env.EXIT_ON_UNCAUGHT === 'true';
process.on('uncaughtException', (err, origin) => {
  logger.fatal(
    `Uncaught exception — ${EXIT_ON_UNCAUGHT ? 'exiting for restart' : 'logged, process kept alive'}`,
    { origin, error: err instanceof Error ? err : String(err) }
  );
  if (EXIT_ON_UNCAUGHT) process.exit(1);
});

const LISTEN_RETRY_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 30000;
let server;

function startServer() {
  const srv = app.listen(PORT, () => {
    logger.info(`Outlook Attachment Pipeline running at http://localhost:${PORT}`);
    // Cron starts ONLY once this process owns the port
    try {
      startCronJob(); // idempotent
    } catch (err) {
      logger.error('Cron job failed to start — HTTP API still available', err);
    }
  });
  server = srv;
  srv.on('error', (err) => {
    if (srv.listening) {
      logger.error('HTTP server runtime error', err);
      return;
    }
    // e.g. EADDRINUSE — an old instance still holds the port
    logger.error(`HTTP server could not listen on port ${PORT} (${err.code || err.message}) — retrying in ${LISTEN_RETRY_MS / 1000}s`, err);
    try { srv.close(); } catch { /* not listening */ }
    setTimeout(startServer, LISTEN_RETRY_MS);
  });
}

startServer();

let shuttingDown = false;

// Stop scheduling, let a run in progress finish (bounded), then exit
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down`);
  stopCronJob();
  server?.close();

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (getCronStatus().isRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (getCronStatus().isRunning) logger.warn('Shutdown timeout reached while a run was still in progress');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
