import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

// One JSON object per line
const REVIEW_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs', 'needs-review.jsonl');

/** Never throws */
export function recordNeedsReview(entry) {
  try {
    fs.mkdirSync(path.dirname(REVIEW_FILE), { recursive: true });
    fs.appendFileSync(REVIEW_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    logger.error('Could not write needs-review file', { error: err?.message });
  }
}
