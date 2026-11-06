import cron from 'node-cron';
import { logger } from './logger.js';
import { runEmailProcessingJob } from './emailProcessingService.js';

// Schedule in standard cron syntax
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *';

// Set CRON_ENABLED=false in .env to disable the scheduled job entirely
const CRON_ENABLED = process.env.CRON_ENABLED !== 'false';

// Same filters shape /api/execute accepts
const CRON_FILTERS = {
  maxResults: Number(process.env.CRON_MAX_RESULTS) || 25,
};

// Watchdog: if a run is STILL going after this many minutes it is assumed hung
const RUN_TIMEOUT_MINUTES =
  process.env.CRON_RUN_TIMEOUT_MINUTES === undefined ? 60 : Number(process.env.CRON_RUN_TIMEOUT_MINUTES) || 0;

let isRunning = false;
let lastRun = null;
let task = null;

// Free memory after each run (needs --expose-gc)
function freeMemoryAfterRun() {
  if (typeof global.gc === 'function') {
    const before = process.memoryUsage().heapUsed;
    global.gc();
    const after = process.memoryUsage().heapUsed;
    logger.info('Post-run garbage collection', {
      freedMB: Math.max(0, Math.round(((before - after) / 1024 / 1024) * 10) / 10),
      heapUsedMB: Math.round((after / 1024 / 1024) * 10) / 10
    });
  } else {
    // Not fatal — the memory is still unreferenced and V8 will reclaim it on its own eventually
    logger.warn(
      'global.gc() unavailable — process was not started with --expose-gc, ' +
        'so post-run memory reclaim relies on V8\'s own GC scheduling instead of being forced here.'
    );
  }
}

async function runJob(trigger = 'schedule') {
  if (isRunning) {
    logger.warn('Skipped cron run — previous run still in progress', { trigger });
    return { status: 'skipped-already-running', skipped: true, reason: 'already running' };
  }

  isRunning = true;
  const startedAt = Date.now();
  let watchdog;
  let abandoned = false;
  if (RUN_TIMEOUT_MINUTES > 0) {
    watchdog = setTimeout(() => {
      abandoned = true;
      logger.fatal('Email processing run exceeded its time limit — assumed hung; releasing lock so the next run can start (process kept alive)', {
        trigger,
        limitMinutes: RUN_TIMEOUT_MINUTES,
        ranMinutes: Math.round((Date.now() - startedAt) / 60000)
      });
      lastRun = {
        at: new Date().toISOString(),
        trigger,
        ok: false,
        error: `Run exceeded ${RUN_TIMEOUT_MINUTES} min and was abandoned`
      };
      isRunning = false;
    }, RUN_TIMEOUT_MINUTES * 60 * 1000);
    watchdog.unref();
  }
  try {
    logger.info('Starting email processing run', { trigger });
    const result = await runEmailProcessingJob(CRON_FILTERS);
    if (!abandoned) lastRun = { at: new Date().toISOString(), trigger, ok: true, result };
    return result;
  } catch (err) {
    logger.error('Email processing run failed', err);
    if (!abandoned) lastRun = { at: new Date().toISOString(), trigger, ok: false, error: err?.message ?? String(err) };
    throw err;
  } finally {
    clearTimeout(watchdog);
    // An abandoned run must not clobber the lock of a newer run
    if (!abandoned) isRunning = false;
    try {
      freeMemoryAfterRun();
    } catch (gcErr) {
      logger.error('Post-run cleanup failed', gcErr);
    }
  }
}

/** Starts the scheduled cron job */
export function startCronJob() {
  if (!CRON_ENABLED) {
    logger.info('Cron job disabled (CRON_ENABLED=false)');
    return;
  }
  if (task) return; // already started

  if (!cron.validate(CRON_SCHEDULE)) {
    logger.error(`Invalid CRON_SCHEDULE "${CRON_SCHEDULE}" — cron job not started`);
    return;
  }

  task = cron.schedule(CRON_SCHEDULE, () => {
    try {
      runJob('schedule').catch(() => {
        // Already logged in runJob; swallow here so node-cron keeps scheduling future runs
      });
    } catch (err) {
      logger.error('Cron tick failed to start a run', err);
    }
  });

  logger.info(`Cron job scheduled with pattern "${CRON_SCHEDULE}"`);
}

/** Stops the scheduled cron job, if running */
export function stopCronJob() {
  if (task) {
    task.stop();
    task = null;
  }
}

/** Triggers a run immediately, outside the schedule (e.g. from a manual endpoint) */
export function runNow() {
  return runJob('manual');
}

/** Returns basic status info, e.g. for a health/monitoring endpoint */
export function getCronStatus() {
  return {
    enabled: CRON_ENABLED,
    schedule: CRON_SCHEDULE,
    isRunning,
    lastRun,
  };
}