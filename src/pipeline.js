import { searchAttachments, downloadAttachment, markAsRead, getMessageBody } from './outlookService.js';
import {
  classifyAttachment,
  mimeTypeFromFilename,
  extractExcelRows,
  extractPdfText,
  stripHtml,
  PasswordProtectedError
} from './parsers/fileParsers.js';
import { listZipEntries, ZipError } from './parsers/zipParser.js';
import { extractStructuredData, extractStructuredDataFromImage } from './services/aiExtractionService.js';
import { getSkippedSubjectKeywords } from './services/skippedSubjectsService.js';
import { refreshExtractionKeywords } from './services/keywordsService.js';
import { logger } from './logger.js';
import { recordNeedsReview } from './utils/reviewLog.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Ceiling on the TOTAL uncompressed bytes we will unpack from ONE zip attachment
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

// Static list of payroll-team senders whose messages must never be run

const PAYROLL_TEAM_EMAILS = [
  'Praneeth.V@quesscorp.com',
  'Sanjeeth.S@quesscorp.com',
  'Nishmitha.MT@quesscorp.com',
  'priyanka.singh1@quesscorp.com',
  'Manjunath.P@quesscorp.com',
  'Sohail.Mohammed@quesscorp.com'
];

// RE Subject Validation

function isSkippedSubject(subject, skippedSubjectKeywords) {
  const lower = (subject || '').toLowerCase();
  return skippedSubjectKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}



// Email Extraction from Outlook Service

function extractEmailAddress(from) {
  const match = /<([^>]+)>/.exec(from || '');
  return (match ? match[1] : from || '').trim().toLowerCase();
}

/** True if `from` belongs to the static payroll-team list above */

function isPayrollTeamEmail(from) {
  return PAYROLL_TEAM_EMAILS.includes(extractEmailAddress(from));
}

// Static list of filename keywords that indicate a file should be skipped entirely
const SKIPPED_FILENAME_KEYWORDS = ['ledger'];

/** True if any of SKIPPED_FILENAME_KEYWORDS appears anywhere in the filename (case-insensitive) */
function isSkippedFilename(filename) {
  const lower = (filename || '').toLowerCase();
  return SKIPPED_FILENAME_KEYWORDS.some((kw) => lower.includes(kw));
}

// Password list, tried in order ("loop mode") whenever a PDF comes back password-protected
const PDF_PASSWORD_LIST = [
  '194010', '010618', 'QUES0618',
  '005323', '003194', 'QUES3194',
  '456051', '104078', 'QUES4078',
  '002284', '000111', 'QUES0111'
];


async function tryPdfPasswordList(buffer) {
  let lastErr;
  for (const password of PDF_PASSWORD_LIST) {
    try {
      return await extractPdfText(buffer, password);
    } catch (err) {
      if (!(err instanceof PasswordProtectedError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Maximum number of concurrent attachment extractions (LLM calls) to allow
const EXTRACTION_CONCURRENCY = Math.max(1, Number(process.env.EXTRACTION_CONCURRENCY) || 5);

/** Buffers a download stream into a single Buffer */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function dedupeAttachments(messages) {
  const seen = new Set();
  const flat = [];
  for (const msg of messages) {
    for (const att of msg.attachments) {
      const key = `${msg.uid}:${att.partId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flat.push({
        uid: msg.uid,
        partId: att.partId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        subject: msg.subject,
        from: msg.from,
        date: msg.date
      });
    }
  }
  return flat;
}

// Returns a unique identifier for one attachment
function attachmentId(att) {
  return `${att.uid}:${att.partId}`;
}

// Builds one ExtractedDocument object for a given attachment
function toDocument(att, kind, rows, extra = {}) {
  return {
    sourceFile: att.filename,
    sourceSubject: att.subject,
    sourceFrom: att.from,
    sourceDate: att.date,
    sourceUid: attachmentId(att),
    kind,
    ...extra, // e.g. { pageCount } for PDFs
    rows
  };
}


async function getBodyText(client, uid) {
  const body = await getMessageBody(client, uid);
  const raw = body?.content || '';
  const isHtml = (body?.contentType || '').toLowerCase() === 'html';
  return (isHtml ? stripHtml(raw) : raw).trim();
}

async function extractBodyDocument(client, msg, warnings, errors) {
  const label = `${msg.subject || '(no subject)'} (email body)`;

  if (isPayrollTeamEmail(msg.from)) {
    addError(errors, label, 'extract', new Error('payroll team emails we not processed'), msg.uid);
    return null;
  }

  let text;
  try {
    text = await getBodyText(client, msg.uid);
  } catch (err) {
    addError(errors, label, 'download', err, msg.uid);
    return null;
  }

  if (!text) {
    addWarning(errors, label, 'email body is empty.', '', msg.uid);
    return null;
  }

  try {
    const structured = await extractStructuredData(text, {
      filename: label,
      subject: msg.subject,
      errors,
      sourceUid: msg.uid
    });

    // Most email bodies are cover notes
    const hasUsefulData =
      structured.Invoices.length > 0 ||
      structured.Beneficiary_Name ||
      structured.Remittance_Amount ||
      structured.Debit_Amount ||
      structured.UTR_No ||
      structured.Remitter_Name;

    if (!hasUsefulData) {
      addWarning(errors, label, 'email body has no extractable payment data.', '', msg.uid);
      return null;
    }

    return {
      sourceFile: label,
      sourceSubject: msg.subject,
      sourceFrom: msg.from,
      sourceDate: msg.date,
      sourceUid: msg.uid,
      kind: 'email-body',
      rows: [structured]
    };
  } catch (err) {
    addError(errors, label, 'extract', err, msg.uid);
    return null;
  }
}

function addWarning(errors, filename, message, stage, sourceUid, mailUid = sourceUid) {
  logger.warn(`Skipped "${filename}": ${message}`, { filename, stage, sourceUid, mailUid });
  errors.push({ file: filename, stage, message, sourceUid, mailUid, level: 'warning' });
}


function addError(errors, filename, stage, err, sourceUid, mailUid = sourceUid, { review = false } = {}) {
  const message = err?.message ?? String(err);
  // review=true is only passed for failures AFTER the source message was marked read
  if (review) recordNeedsReview({ kind: 'extraction-failed', file: filename, stage, mailUid, sourceUid, reason: message });
  // Persist to error-*.log too
  logger.error(`Extraction failed for "${filename}" (stage: ${stage})`, {
    filename,
    stage,
    sourceUid,
    mailUid,
    error: message,
    stack: err?.stack
  });
  errors.push({ file: filename, stage, message, sourceUid, mailUid, level: 'error' });
}


async function mapWithConcurrency(items, limit, fn) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}


/** Runs the full pipeline server-side against an already-authenticated Microsoft Graph client */
export async function runExtractionPipeline(client, filters) {
  const warnings = [];
  const errors = [];
  const documents = [];
  // Every extracted document goes through here
  const pushDocument = (doc) => documents.push(doc);
  // Reading + AI-extracting every message body is an extra LLM call per email on top of whatever

  // Phase 1: search
  const searchedMessages = await searchAttachments(client, filters);
  const skippedSubjectKeywords = await getSkippedSubjectKeywords();
  await refreshExtractionKeywords();

  const permanentSkipReason = (msg) => {
    if (isPayrollTeamEmail(msg.from)) return 'payroll-team';
    if (isSkippedSubject(msg.subject, skippedSubjectKeywords)) return 'skipped-subject-keyword';
    return null;
  };
  const isPermanentlySkipped = (msg) => permanentSkipReason(msg) !== null;
  const messages = searchedMessages.filter((msg) => !isPermanentlySkipped(msg));
  const permanentlySkipped = searchedMessages.filter(isPermanentlySkipped);
  if (permanentlySkipped.length > 0) {
    logger.info(
      `Skipping ${permanentlySkipped.length} message(s) ("Re:"/"Fw:" subject, payroll-team sender, or skipped-subject-keyword) — marking read so they don't repeat`,
      {
        skipped: permanentlySkipped.map((msg) => ({
          uid: msg.uid,
          subject: msg.subject,
          from: msg.from,
          reason: permanentSkipReason(msg)
        }))
      }
    );
    await Promise.all(
      permanentlySkipped.map(async (msg) => {
        try {
          await markAsRead(client, msg.uid);
        } catch (err) {
          logger.warn('Failed to mark permanently-skipped message as read', {
            uid: msg.uid,
            subject: msg.subject,
            error: err.message
          });
        }
      })
    );
  }

  const attachments = dedupeAttachments(messages);

  if (messages.length === 0) {
    return { messages, documents, errors };
  }

  // Tracks which messages have already been marked read
  const markedReadUids = new Set();

  // Phase 2+3: download AND extract together, per attachment, bounded by EXTRACTION_CONCURRENCY
  const inFlightExtractions = new Set();

  async function runExtraction(att, kind, buffer) {
    const extraction = (async () => {
      try {
        if (kind === 'excel') {
          // Only format that skips the LLM — already reliably tabular
          const parsed = extractExcelRows(buffer);
          if (parsed.length === 0) {
            addWarning(
              errors,
              att.filename,
              'Excel file parsed to 0 rows (empty sheet(s), or the file may be corrupt).',
              '',
              attachmentId(att),
              att.uid
            );
          } else {
            pushDocument(toDocument(att, kind, parsed));
          }
        } else if (kind === 'csv') {
          const text = buffer.toString('utf-8');
          const structured = await extractStructuredData(text, {
            filename: att.filename,
            subject: att.subject,
            errors,
            sourceUid: attachmentId(att)
          });
          pushDocument(toDocument(att, kind, [structured]));
        } else if (kind === 'pdf') {
          let pdfResult;
          try {
            pdfResult = await extractPdfText(buffer);
          } catch (err) {
            if (!(err instanceof PasswordProtectedError)) throw err;

            // Password-protected: try PDF_PASSWORD_LIST, else skip with a warning
            try {
              pdfResult = await tryPdfPasswordList(buffer);
            } catch (retryErr) {
              if (retryErr instanceof PasswordProtectedError) {
                addWarning(
                  errors,
                  att.filename,
                  'Password protected PDF — none of the passwords in the list opened it.',
                  '',
                  attachmentId(att),
                  att.uid
                );
                return;
              }
              logger.error('Failed to extract password-protected PDF via password list', {
                filename: att.filename,
                subject: att.subject,
                sourceUid: attachmentId(att),
                mailUid: att.uid,
                error: retryErr
              });
              throw retryErr;
            }
          }
          const { text, hasTextLayer, numPages } = pdfResult;
          if (!hasTextLayer) {
            addWarning(
              errors,
              att.filename,
              'Scanned PDF with no text layer — scanned-PDF OCR is not supported yet ' +
              '(only image attachments go through vision OCR). Convert it to an image or a ' +
              'text-searchable PDF to extract it.',
              '',
              attachmentId(att),
              att.uid
            );
            return;
          }
          const structured = await extractStructuredData(text, {
            filename: att.filename,
            subject: att.subject,
            errors,
            sourceUid: attachmentId(att)
          });
          pushDocument(toDocument(att, kind, [structured], { pageCount: numPages }));
        } else if (kind === 'image') {
          const structured = await extractStructuredDataFromImage(buffer, att.mimeType, {
            filename: att.filename,
            subject: att.subject,
            errors,
            sourceUid: attachmentId(att)
          });
          pushDocument(toDocument(att, kind, [structured]));
        }
      } catch (err) {
        // Password-protected file: nothing we can do without the password
        if (err instanceof PasswordProtectedError) {
          addWarning(errors, att.filename, err.message, '', attachmentId(att), att.uid);
          return;
        }
        // Extraction failed (e.g. OpenAI/LangChain error after retries)
        addError(errors, att.filename, 'extract', err, attachmentId(att), att.uid, { review: true });
      }
    })();

    inFlightExtractions.add(extraction);
    extraction.finally(() => inFlightExtractions.delete(extraction));

    // Backpressure: don't start the next download until at least one in-flight extraction
    if (inFlightExtractions.size >= EXTRACTION_CONCURRENCY) {
      await Promise.race(inFlightExtractions);
    }
  }

  /** Unpacks one downloaded .zip and pushes each supported inner file */
  async function processZipAttachment(att, zipBuffer) {
    const zipId = attachmentId(att);

    let archive;
    try {
      archive = listZipEntries(zipBuffer);
    } catch (err) {
      if (err instanceof ZipError && err.code !== 'INVALID') {
        addWarning(errors, att.filename, `ZIP skipped: ${err.message}.`, '', zipId, att.uid);
      } else {
        addError(errors, att.filename, 'extract', err, zipId, att.uid, { review: true });
      }
      return;
    }

    if (archive.entries.length === 0) {
      addWarning(errors, att.filename, 'ZIP is empty (no files inside).', '', zipId, att.uid);
      return;
    }

    // One log line per zip to help diagnose empty extractions
    logger.info(`Opened ZIP ${att.filename}: ${archive.entries.length} file(s)`, {
      sourceUid: zipId,
      files: archive.entries.map((e) => ({ name: e.name, bytes: e.size, encrypted: e.encrypted })),
      ignoredJunk: archive.junkCount
    });

    let unpackedBytes = 0;
    let handedToExtraction = 0;

    for (const entry of archive.entries) {
      const inner = {
        ...att,
        filename: entry.name,
        partId: `${att.partId}#${entry.index}`,
        mimeType: mimeTypeFromFilename(entry.name),
        size: entry.size,
        archiveName: att.filename
      };
      const innerId = attachmentId(inner);
      const label = `${entry.name} (in ${att.filename})`;

      if (isSkippedFilename(entry.name)) {
        addWarning(errors, entry.name, `Ledger file inside ${att.filename} — skipped.`, '', innerId, att.uid);
        continue;
      }
      if (entry.encrypted) {
        addWarning(errors, entry.name, `Password protected file inside ${att.filename} — cannot be read.`, '', innerId, att.uid);
        continue;
      }
      if (entry.size > MAX_ATTACHMENT_BYTES) {
        addWarning(errors, entry.name, `larger than 25 MB (inside ${att.filename}).`, '', innerId, att.uid);
        continue;
      }

      const innerKind = classifyAttachment(inner.filename, inner.mimeType);
      if (innerKind === 'unsupported' || innerKind === 'zip') {
        const why = innerKind === 'zip' ? 'nested ZIP files are not unpacked' : 'unsupported file type';
        addWarning(errors, entry.name, `${why} (inside ${att.filename}).`, '', innerId, att.uid);
        continue;
      }

      if (unpackedBytes + entry.size > MAX_ZIP_UNCOMPRESSED_BYTES) {
        addWarning(
          errors,
          entry.name,
          `skipped: ${att.filename} unpacks to more than ${MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024)} MB in total.`,
          '',
          innerId,
          att.uid
        );
        continue;
      }

      let data;
      try {
        data = entry.read();
      } catch (err) {
        addError(errors, entry.name, 'extract', err, innerId, att.uid, { review: true });
        continue;
      }
      // Re-check with the REAL size (headers can lie) before handing
      if (unpackedBytes + data.length > MAX_ZIP_UNCOMPRESSED_BYTES) {
        addWarning(
          errors,
          entry.name,
          `skipped: ${att.filename} unpacks to more than ${MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024)} MB in total.`,
          '',
          innerId,
          att.uid
        );
        continue;
      }
      unpackedBytes += data.length;
      handedToExtraction += 1;
      logger.info(`Unpacked ${label}`, { kind: innerKind, bytes: data.length, sourceUid: innerId });
      await runExtraction(inner, innerKind, data);
    }

    if (handedToExtraction === 0) {
      addWarning(errors, att.filename, 'ZIP contained no supported files (need pdf/excel/csv/image).', '', zipId, att.uid);
    }
  }

  for (const att of attachments) {
    if (isPayrollTeamEmail(att.from)) {
      addError(
        errors,
        att.filename,
        'extract',
        new Error('payroll team emails we not processed'),
        attachmentId(att),
        att.uid
      );
      continue;
    }

    if (isSkippedFilename(att.filename)) {
      addWarning(
        errors,
        att.filename,
        'Ledger file — skipped (not downloaded or extracted).',
        '',
        attachmentId(att),
        att.uid
      );
      continue;
    }

    if (att.size > MAX_ATTACHMENT_BYTES) {
      addWarning(errors, att.filename, 'larger than 25 MB.', '', attachmentId(att), att.uid);
      continue;
    }

    const kind = classifyAttachment(att.filename, att.mimeType);
    if (kind === 'unsupported') {
      addWarning(errors, att.filename, 'unsupported attachment type.', '', attachmentId(att), att.uid);
      continue;
    }

    let buffer;
    try {
      const { content } = await downloadAttachment(client, att.uid, att.partId);
      buffer = await streamToBuffer(content);
    } catch (err) {
      addError(errors, att.filename, 'download', err, attachmentId(att), att.uid);
      continue; // move on to the next attachment
    }

    // Mark the source message read now that we've successfully pulled an attachment
    if (!markedReadUids.has(att.uid)) {
      markedReadUids.add(att.uid);
      try {
        await markAsRead(client, att.uid);
      } catch (err) {
        addWarning(
          errors,
          att.filename,
          `Downloaded, but failed to mark source email as read: ${err.message}`,
          '',
          attachmentId(att),
          att.uid
        );
      }
    }

    // buffer is only captured by this attachment's own extraction closure below
    if (kind === 'zip') {
      await processZipAttachment(att, buffer);
    } else {
      await runExtraction(att, kind, buffer);
    }
  }

  // Drain any extractions still in flight after the last download
  await Promise.all(inFlightExtractions);

  // A message whose attachments are ALL "Ledger" files never gets marked read above
  for (const msg of messages) {
    if (
      msg.attachments.length > 0 &&
      msg.attachments.every((a) => isSkippedFilename(a.filename)) &&
      !markedReadUids.has(msg.uid)
    ) {
      markedReadUids.add(msg.uid);
      try {
        await markAsRead(client, msg.uid);
      } catch (err) {
        addWarning(
          errors,
          msg.subject,
          `All attachments were Ledger files (skipped), but failed to mark source email as read: ${err.message}`,
          '',
          msg.uid
        );
      }
    }
  }


  // Phase 4: email body (concurrent — independent network/LLM calls, same as Phase 3)
  if (messages.length > 0) {
    await mapWithConcurrency(messages, EXTRACTION_CONCURRENCY, async (msg) => {
      const doc = await extractBodyDocument(client, msg, warnings, errors);
      if (doc) {
        pushDocument(doc);
      }
      // Mark read once the body has been successfully extracted
      if (doc && !markedReadUids.has(msg.uid)) {
        markedReadUids.add(msg.uid);
        try {
          await markAsRead(client, msg.uid);
        } catch (err) {
          addWarning(
            errors,
            doc.sourceFile,
            `Extracted, but failed to mark source email as read: ${err.message}`,
            '',
            msg.uid
          );
        }
      }
    });
  }

  return { messages, documents, errors };
}
