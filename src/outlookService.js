import { Readable } from 'node:stream';
import { logger } from './logger.js';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Timeouts so a stalled call can't hold the cron run; larger for big downloads
const GRAPH_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS) || 120000;
const TOKEN_TIMEOUT_MS = Number(process.env.GRAPH_TOKEN_TIMEOUT_MS) || 30000;


export async function connectOutlook(
  userEmail = process.env.OUTLOOK_USER_EMAIL,
  tenantId = process.env.AZURE_TENANT_ID,
  clientId = process.env.AZURE_CLIENT_ID,
  clientSecret = process.env.AZURE_CLIENT_SECRET
) {
  if (!userEmail || !tenantId || !clientId || !clientSecret) {
    logger.error('Server Outlook credentials are not configured', {
      missing: Object.entries({ userEmail, tenantId, clientId, clientSecret })
        .filter(([, v]) => !v)
        .map(([k]) => k)
    });
    throw new OutlookAuthError(
      'Server Outlook credentials are not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, ' +
        'AZURE_CLIENT_SECRET, and OUTLOOK_USER_EMAIL in server/.env.'
    );
  }

  let accessToken;
  try {
    accessToken = await acquireAppToken(tenantId, clientId, clientSecret);
  } catch (err) {
    logger.error('Microsoft Graph auth failed', { error: err.message });
    throw new OutlookAuthError(describeAuthError(err));
  }

  // No persistent connection to hold open (unlike IMAP)

  return { accessToken, userEmail, logout: async () => {} };
}

class OutlookAuthError extends Error {}

async function acquireAppToken(tenantId, clientId, clientSecret) {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `Token request failed (HTTP ${res.status})`);
  }
  if (!body.access_token) {
    logger.error('Microsoft Graph auth failed: no access_token in response', { responseBody: body });
    throw new Error(
      'Token endpoint returned HTTP 200 but no access_token was present in the response body. ' +
        'This usually means AZURE_TENANT_ID is wrong (the request silently resolved to the wrong ' +
        'authority) or the token response was intercepted/altered by a proxy.'
    );
  }
  return body.access_token;
}

function describeAuthError(err) {
  const msg = String(err?.message || err);
  if (/AADSTS7000215|invalid_client|AADSTS700016/i.test(msg)) {
    return 'Microsoft Graph rejected the app credentials. Check AZURE_CLIENT_ID/AZURE_CLIENT_SECRET — see README.';
  }
  if (/AADSTS90002/i.test(msg)) {
    return 'Unknown Azure tenant. Check AZURE_TENANT_ID — see README.';
  }
  if (/AADSTS700016/i.test(msg)) {
    return 'Unknown application. Check AZURE_CLIENT_ID — see README.';
  }
  return `Microsoft Graph auth failed: ${msg}`;
}


const GRAPH_MAX_CONCURRENCY = Math.max(1, Number(process.env.GRAPH_MAX_CONCURRENCY) || 3);
const GRAPH_MAX_RETRIES = Number.isNaN(Number.parseInt(process.env.GRAPH_MAX_RETRIES, 10))
  ? 4
  : Number.parseInt(process.env.GRAPH_MAX_RETRIES, 10);
const GRAPH_RETRY_BASE_MS = 1000;
const GRAPH_RETRY_MAX_MS = 30000;

let graphActive = 0;
const graphWaiters = [];

async function acquireGraphSlot() {
  if (graphActive < GRAPH_MAX_CONCURRENCY) {
    graphActive++;
    return;
  }
  await new Promise((resolve) => graphWaiters.push(resolve)); // slot is handed over directly
}

function releaseGraphSlot() {
  const next = graphWaiters.shift();
  if (next) next(); // keep graphActive as is: ownership passes to the waiter
  else graphActive--;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(res, attempt) {
  const header = Number(res.headers.get('retry-after'));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : GRAPH_RETRY_BASE_MS * 2 ** attempt;
  return Math.min(base, GRAPH_RETRY_MAX_MS) + Math.floor(Math.random() * 250); // jitter
}

/** Thrown when Graph answers 2xx but the body is not parseable JSON */
class GraphJsonError extends Error {}

async function readGraphJson(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    const pos = Number(/position (\d+)/.exec(err.message)?.[1]);
    logger.error('Microsoft Graph returned malformed JSON', {
      label,
      error: err.message,
      status: res.status,
      contentType: res.headers.get('content-type'),
      contentEncoding: res.headers.get('content-encoding'),
      contentLengthHeader: res.headers.get('content-length'),
      receivedChars: text.length,
      requestId: res.headers.get('request-id') || res.headers.get('client-request-id'),
      around: Number.isFinite(pos) ? text.slice(Math.max(0, pos - 80), pos + 80) : undefined
    });
    throw new GraphJsonError(`Graph returned malformed JSON for ${label}: ${err.message}`);
  }
}

/** Thin wrapper around fetch that adds the bearer token and surfaces Graph's error body */
async function graphFetch(client, path, options = {}) {
  const safePath = path.split('?')[0].replace(/\/messages\/[^/]+/, '/messages/<id>');

  for (let attempt = 0; ; attempt++) {
    let res;
    await acquireGraphSlot();
    try {
      res = await fetch(`${GRAPH_BASE}${path}`, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${client.accessToken}`,
          ...(options.headers || {})
        }
      });
    } finally {
      releaseGraphSlot();
    }

    if (res.ok) return res;

    const retryable = res.status === 429 || res.status === 503 || res.status === 504;
    if (retryable && attempt < GRAPH_MAX_RETRIES) {
      const delay = retryDelayMs(res, attempt);
      await res.arrayBuffer().catch(() => {}); // free the connection
      logger.warn('Microsoft Graph throttled/unavailable — retrying', {
        status: res.status,
        method: options.method || 'GET',
        path: safePath,
        attempt: attempt + 1,
        delayMs: delay
      });
      await sleep(delay);
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message || `Graph request failed (HTTP ${res.status})`;
    logger.error('Microsoft Graph request failed', {
      status: res.status,
      method: options.method || 'GET',
      path: safePath,
      error: message
    });
    throw new Error(message);
  }
}


/** Only unread messages are fetched */
const UNREAD_FILTER = 'isRead eq false';

export async function searchAttachments(client, filters) {
  const requested = Math.floor(Number(filters.maxResults));
  const maxResults = requested > 0 ? requested : 25; // NaN / 0 / negative -> default
  const top = Math.min(maxResults, 100);

  let items;
  for (let attempt = 1; attempt <= 2 && !items; attempt++) {
    try {
      items = await searchMessagesPage(client, { top, expand: true });
    } catch (err) {
      if (!(err instanceof GraphJsonError)) throw err;
      logger.warn('Outlook search returned malformed JSON', { attempt, top });
    }
  }


  if (!items) {
    const smallTop = Math.min(top, 10);
    logger.warn('Falling back to lightweight Outlook search', { top: smallTop });
    try {
      items = await searchMessagesPage(client, { top: smallTop, expand: false });
    } catch (err) {
      logger.error('Outlook search failed', { error: err.message });
      throw new Error(`Outlook search failed: ${err.message}`);
    }
    const hydrated = [];
    for (const msg of items) {
      try {
        msg.attachments = await listMessageAttachments(client, msg.id);
        hydrated.push(msg);
      } catch (err) {
        // Do NOT push it with attachments: []
        logger.warn('Skipping message — could not list its attachments', {
          uid: msg.id,
          error: err.message
        });
      }
    }
    items = hydrated;
  }

  items = items.slice().sort((a, b) => {
    const da = a.receivedDateTime ? Date.parse(a.receivedDateTime) : 0;
    const db = b.receivedDateTime ? Date.parse(b.receivedDateTime) : 0;
    return db - da;
  });

  return items.map((msg) => ({
    uid: msg.id,
    subject: msg.subject || '(no subject)',
    from: formatAddress(msg.from),
    date: msg.receivedDateTime ? new Date(msg.receivedDateTime).toISOString() : '',
    attachments: (msg.attachments ?? [])
      .filter((a) => !a.isInline)
      .map((a) => ({
        partId: a.id,
        filename: a.name || `attachment-${a.id}`,
        mimeType: (a.contentType || 'application/octet-stream').toLowerCase(),
        size: a.size ?? 0
      }))
  }));
}

async function searchMessagesPage(client, { top, expand }) {
  const params = new URLSearchParams();
  params.set('$filter', UNREAD_FILTER);
  params.set('$top', String(top));
  params.set('$select', 'id,subject,from,receivedDateTime,hasAttachments');
  if (expand) params.set('$expand', 'attachments($select=id,name,contentType,size,isInline)');

  let res;
  try {
    res = await graphFetch(
      client,
      `/users/${encodeURIComponent(client.userEmail)}/messages?${params.toString()}`
    );
  } catch (err) {
    logger.error('Outlook search failed', { error: err.message });
    throw new Error(`Outlook search failed: ${err.message}`);
  }

  const body = await readGraphJson(res, `message search (top=${top}, expand=${expand})`);
  return body.value ?? [];
}

async function listMessageAttachments(client, uid) {
  const res = await graphFetch(
    client,
    `/users/${encodeURIComponent(client.userEmail)}/messages/${encodeURIComponent(uid)}/attachments` +
      `?$select=${encodeURIComponent('id,name,contentType,size,isInline')}`
  );
  const body = await readGraphJson(res, 'attachment list');
  return body.value ?? [];
}

function formatAddress(from) {
  const addr = from?.emailAddress;
  if (!addr) return '(unknown sender)';
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

export async function getMessageBody(client, uid) {
  const res = await graphFetch(
    client,
    `/users/${encodeURIComponent(client.userEmail)}/messages/${encodeURIComponent(uid)}?$select=body`
  );
  const meta = await readGraphJson(res, 'message body');
  return meta.body ?? { contentType: 'text', content: '' };
}


export async function downloadAttachment(client, uid, partId) {
  const base = `/users/${encodeURIComponent(client.userEmail)}/messages/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(partId)}`;

  // Preferred: /$value returns raw bytes (avoids a ~33 MB base64 JSON copy)
  try {
    const res = await graphFetch(client, `${base}/$value`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      content: Readable.from(buffer),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      filename: undefined
    };
  } catch (err) {
    logger.warn('Raw attachment download failed — falling back to base64 JSON', { error: err.message });
  }

  // Fallback: base64 JSON (no $select, Graph rejects contentBytes)
  const res = await graphFetch(client, base);
  const meta = await readGraphJson(res, 'attachment (base64 fallback)');
  const buffer = Buffer.from(meta.contentBytes || '', 'base64');
  meta.contentBytes = null;
  const content = Readable.from(buffer);
  return { content, contentType: meta.contentType || 'application/octet-stream', filename: meta.name };
}

/** Marks a message as read (isRead: true) — the Graph equivalent of the IMAP \Seen flag */
export async function markAsRead(client, uid) {
  await graphFetch(client, `/users/${encodeURIComponent(client.userEmail)}/messages/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true })
  });
}