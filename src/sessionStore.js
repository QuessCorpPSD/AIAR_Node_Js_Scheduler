import { logger } from './logger.js';
import crypto from 'node:crypto';

/** In-memory session store */
const sessions = new Map();

const IDLE_TIMEOUT_MS =
  (Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES) || 30) * 60 * 1000;

export function createSession(client, email) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { client, email, lastUsed: Date.now() });
  return sessionId;
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.lastUsed = Date.now();
  return session;
}

export async function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    await session.client.logout();
  } catch {
    // Connection may already be dead — that's fine, we're discarding
  }
}

// Periodically sweep idle sessions so abandoned entries don't pile up
setInterval(async () => {
  try {
    const now = Date.now();
    for (const [sessionId, session] of [...sessions.entries()]) {
      if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
        await destroySession(sessionId);
      }
    }
  } catch (err) {
    logger.error('Session sweep failed', err);
  }
}, 60_000).unref();
