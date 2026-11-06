import { ImapFlow } from 'imapflow';

/** Opens an authenticated IMAP connection to Gmail */
export async function connectImap(
  email = process.env.GMAIL_EMAIL,
  appPassword = process.env.GMAIL_APP_PASSWORD
) {
  if (!email || !appPassword) {
    logger.error('Gmail credentials not configured', { emailConfigured: !!email, appPasswordConfigured: !!appPassword });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false
  });

  try {
    await client.connect();
  } catch (err) {
    logger.error('IMAP connection failed', { error: err.message });
  }
  return client;
}

export class ImapAuthError extends Error {}

function describeImapError(err) {
  const msg = String(err?.message || err);
  if (/invalid credentials|authenticationfailed/i.test(msg)) {
    return 'Gmail rejected the login. Use an App Password (not your normal password) — see README.';
  }
  if (/too many/i.test(msg)) {
    return 'Too many failed login attempts. Wait a few minutes and try again.';
  }
  return `IMAP connection failed: ${msg}`;
}

/** Gmail exposes all mail under a special-use mailbox */
async function openAllMail(client) {
  const list = await client.list();
  const allMail = list.find((box) => box.specialUse === '\\All');
  const target = allMail?.path ?? 'INBOX';
  const lock = await client.getMailboxLock(target);
  return lock;
}

/** Builds a Gmail search query string, identical syntax to the Gmail web UI */
function buildGmailQuery(filters) {
  const clauses = ['has:attachment','is:unread'];
  if (filters.subjectContains) clauses.push(`subject:(${filters.subjectContains})`);
  if (filters.fromContains) clauses.push(`from:(${filters.fromContains})`);
  if (filters.afterDate) clauses.push(`after:${filters.afterDate.replace(/-/g, '/')}`);
  if (filters.beforeDate) clauses.push(`before:${filters.beforeDate.replace(/-/g, '/')}`);
  return clauses.join(' ');
}

/** Searches Gmail */

export async function searchAttachments(client, filters) {
  const lock = await openAllMail(client);
  try {
    const query = buildGmailQuery(filters);
    const maxResults = filters.maxResults ?? 25;

    let uids;
    try {
      uids = await client.search({ gmailRaw: query }, { uid: true });
    } catch (err) {
      throw new Error(
        `Gmail search failed (your account may not support X-GM-RAW extended search): ${err.message}`
      );
      
    }

    if (!uids || uids.length === 0) return [];

    // UIDs come back in ascending (oldest-first) order
    const recentUids = uids.slice(-maxResults).reverse();

    const messages = [];
    for await (const msg of client.fetch(
      recentUids,
      { envelope: true, bodyStructure: true },
      { uid: true }
    )) {
      const attachments = extractAttachmentParts(msg.bodyStructure);
      if (attachments.length === 0) continue;

      messages.push({
        uid: msg.uid,
        subject: msg.envelope?.subject ?? '(no subject)',
        from: formatAddressList(msg.envelope?.from),
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : '',
        attachments
      });
    }
    return messages;
  } finally {
    lock.release();
  }
}

/** Recursively walks a BODYSTRUCTURE tree collecting attachment-like parts */
function extractAttachmentParts(node, acc = []) {
  if (!node) return acc;

  const filename =
    node.dispositionParameters?.filename ??
    node.parameters?.name ??
    (node.disposition === 'attachment' ? `attachment-${node.part ?? 'unknown'}` : null);

  const isAttachment =
    node.disposition === 'attachment' || (filename && node.disposition !== 'inline');

  if (filename && isAttachment && node.part) {
    acc.push({
      partId: node.part,
      filename,
      mimeType: `${node.type}/${node.subtype}`.toLowerCase(),
      size: node.size ?? 0
    });
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((child) => extractAttachmentParts(child, acc));
  }
  return acc;
}

function formatAddressList(addresses) {
  if (!addresses || addresses.length === 0) return '(unknown sender)';
  return addresses
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}

/** Downloads one attachment part as a stream + its content type */
export async function downloadAttachment(client, uid, partId) {
  const lock = await openAllMail(client);
  try {
    const { meta, content } = await client.download(uid, partId, { uid: true });
    return { content, contentType: meta.contentType, filename: meta.filename };
  } finally {
    lock.release();
  }
}

/** Adds the \Seen flag to a message, marking it read */
export async function markAsRead(client, uid) {
  const lock = await openAllMail(client);
  try {
    await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
  } finally {
    lock.release();
  }
}