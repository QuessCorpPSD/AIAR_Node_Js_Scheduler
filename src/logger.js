import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Minimal file logger */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  // Never let a log-directory problem stop the app from booting.
  console.error('Could not create log directory:', err);
}

/** JSON.stringify that cannot throw */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Error) {
        return { name: v.name, message: v.message, code: v.code, stack: v.stack };
      }
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch (err) {
    return JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'Logger could not serialize an entry',
      meta: { reason: String(err) }
    });
  }
}

// How many days of logs to keep before a file becomes eligible for deletion
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 30);

// How often the cleanup sweep runs
const LOG_CLEANUP_INTERVAL_DAYS = Math.max(1, Number(process.env.LOG_CLEANUP_INTERVAL_DAYS) || 7);

const LOG_FILE_PATTERN = /^(app|error)-(\d{4}-\d{2}-\d{2})\.log$/;

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function logFilePath(kind) {
  return path.join(LOG_DIR, `${kind}-${dateStamp()}.log`);
}

function appendTo(kind, serialized) {
  fs.appendFile(logFilePath(kind), serialized + '\n', (err) => {
    if (err) {
      // Fall back to console only if the log file itself can't be written.
      console.error(`Failed to write to ${kind} log file:`, err);
    }
  });
}

function write(level, message, meta) {
  try {
    const line = {
      time: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {})
    };
    // error-level entries go to error-*.log ONLY; everything else (info/warn) goes to app-*.log
    appendTo(level === 'error' ? 'error' : 'app', safeStringify(line));
  } catch (err) {
    console.error('Logger write failed:', err);
  }
}

/** Deletes log files older than LOG_RETENTION_DAYS */
function cleanupOldLogs() {
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) {
      console.error('Log cleanup: failed to read log directory:', err);
      return;
    }

    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const minAgeMs = 2 * 24 * 60 * 60 * 1000; // never touch today/yesterday

    for (const file of files) {
      const match = LOG_FILE_PATTERN.exec(file);
      if (!match) continue; // not one of ours — never touch

      const fileDate = Date.parse(`${match[2]}T00:00:00Z`);
      if (Number.isNaN(fileDate)) continue;

      const age = Date.now() - fileDate;
      if (age < minAgeMs) continue; // too recent, always keep
      if (fileDate >= cutoff) continue; // within retention window, keep

      fs.unlink(path.join(LOG_DIR, file), (unlinkErr) => {
        if (unlinkErr) {
          console.error(`Log cleanup: failed to delete ${file}:`, unlinkErr);
        } else {
          console.log(`Log cleanup: deleted old log file ${file} (past ${LOG_RETENTION_DAYS}-day retention)`);
        }
      });
    }
  });
}

// Clean up once at startup, then on an interval
cleanupOldLogs();
setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000).unref();

export const logger = {
  info(message, meta) {
    write('info', message, meta);
  },
  warn(message, meta) {
    write('warn', message, meta);
  },
  error(message, meta) {
    const errMeta =
      meta instanceof Error ? { error: meta.message, stack: meta.stack } : meta;
    // Errors also go to stderr
    try {
      console.error(message, errMeta ?? '');
    } catch {
      // a broken stderr pipe must never throw out of the logger
    }
    write('error', message, errMeta);
  },
  /** Synchronous error write — use right before process.exit(), when an async append could be lost */
  fatal(message, meta) {
    const line = safeStringify({ time: new Date().toISOString(), level: 'error', message, meta });
    try {
      console.error(message, meta ?? '');
    } catch {
      // ignore
    }
    try {
      fs.appendFileSync(logFilePath('error'), line + '\n');
    } catch {
      // nothing more we can do
    }
  }
};
