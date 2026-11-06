import { connectOutlook } from './outlookService.js';
import { runExtractionPipeline } from './pipeline.js';
import { logger } from './logger.js';
import { extractUtrFromNarration } from './utils/utrExtractor.js';
import { pickAmountFromRow, normalizeHeader } from './utils/amountPriority.js';
import { getKeywordConfig } from './services/keywordsService.js';
import { recordNeedsReview } from './utils/reviewLog.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Failed submissions are appended here (one JSON object per line)
const FAILED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'failed-submissions.jsonl');
function recordFailedSubmission(email, error) {
  try {
    fs.mkdirSync(path.dirname(FAILED_FILE), { recursive: true });
    fs.appendFileSync(
      FAILED_FILE,
      JSON.stringify({
        at: new Date().toISOString(),
        id: email.id,
        file: email.sourceFile,
        subject: email.subject,
        from: email.fromAddress,
        receivedAt: email.receivedAt,
        error: error.message,
        code: error.code,
        timedOut: error.code === 'ECONNABORTED' || /timeout/i.test(error.message),
      }) + '\n'
    );
  } catch (e) {
    logger.error('Could not write failed-submissions file', { error: e.message });
  }
}
import { submitARPaymentDetails, extractEmailAddress } from './services/arKnockOffService.js';

// Min confidence (0-100) to auto-submit; override via MIN_AUTO_SUBMIT_CONFIDENCE
const MIN_AUTO_SUBMIT_CONFIDENCE = Number(process.env.MIN_AUTO_SUBMIT_CONFIDENCE) || 90;

/** Parses a currency/number-ish value into a plain float */
function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Ported from the frontend's validateResponse() */
function validateResponse(documents, errors) {
  if (errors.length > 0) {
    const errorSummary = errors.reduce((acc, error) => {
      const message = error.message || 'Unknown Error';
      acc[message] = (acc[message] || 0) + 1;
      return acc;
    }, {});

    const errorMessage = Object.entries(errorSummary)
      .map(([message, count]) => `${count} file(s): ${message}`)
      .join('\n');

    logger.warn('Extraction pipeline reported errors', { errorMessage });
  }
}

// Column headers that can hold the invoice number in an Excel attachment
function invoiceHeaderGroups() {
  const all = getKeywordConfig().invoiceNumber.map(normalizeHeader).filter(Boolean);
  return {
    invoice: all.filter((h) => !h.startsWith('doc')),
    document: all.filter((h) => h.startsWith('doc'))
  };
}

/** Returns the invoice number from an Excel row, trying each known header */
function getExcelInvoiceNo(row) {
  if (!row) return '';
  const { invoice, document } = invoiceHeaderGroups();
  const keys = Object.keys(row).filter((k) => k !== '__sheet');
  const cell = (hdr) => {
    const key = keys.find((k) => normalizeHeader(k) === hdr);
    return key === undefined ? undefined : row[key];
  };
  const firstOf = (headers) => {
    let present = false;
    for (const h of headers) {
      const v = cell(h);
      if (v === undefined) continue;
      present = true;
      if (v !== null && String(v).trim() !== '') return { present, value: String(v).trim() };
    }
    return { present, value: '' };
  };
  const inv = firstOf(invoice);
  if (inv.present) return inv.value;   // sheet has an invoice column: blank here = no invoice on this row
  return firstOf(document).value;
}

/** Ported 1:1 from the frontend's mapDocumentsToEmails() */
function mapDocumentsToEmails(documents, apiErrors) {
  return documents.map((document) => {
    const rows = document.rows ?? [];
    const isExcel = document.kind === 'excel';

    const excelLineRows = rows.filter((row) => getExcelInvoiceNo(row));

    const excelTotalRow = rows.find(
      (row) =>
        !getExcelInvoiceNo(row) &&
        (row['TDS Rate'] === 'TOTAL' || pickAmountFromRow(row, { maxTier: 6 }) != null)
    );

      const invoiceLines = isExcel
    ? excelLineRows.map((row) => ({
        invoiceNo: getExcelInvoiceNo(row),
        amount: parseAmount(
          pickAmountFromRow(row)?.value ?? row['Invoice Amount']
        ),
        tDS_Amount: parseAmount(row['TDS'] ?? row['TDS Amount'] ?? row['TDS_Amount']),
        tDS_Percent: parseAmount(row['TDS_Percentage'] ?? row['TDS Rate'] ?? row['TDS %']),
      }))
    : rows.flatMap((row) =>
        (row.Invoices ?? []).map((invoice) => ({
          invoiceNo: invoice.Invoice_Number || '',
          amount: parseAmount(invoice.Amount),
          tDS_Amount: parseAmount(invoice.TDS),
          tDS_Percent: parseAmount(invoice.TDS_Percentage),
        }))
      );

    const firstRow = rows[0] ?? {};
    const firstExcelRow = excelLineRows[0] ?? {};

    // True when aiExtractionService's enforceInvoiceNumberPattern dropped one or more Invoices rows
    const invoiceNumberValidationFailed = rows.some((row) => row?.invoiceNumberValidationFailed === true);
    const invoiceNumberValidationMessage = rows.find(
      (row) => row?.invoiceNumberValidationFailed === true
    )?.invoiceNumberValidationMessage;

    return {
      id: crypto.randomUUID(),
      sourceFile: document.sourceFile || '',
      fromAddress: document.sourceFrom || '',
      toAddress: '',
      subject: document.sourceSubject || '',
      receivedAt: document.sourceDate || new Date().toISOString(),
      status: 'CLOSED',
      attachments: [
        {
          sourceFile: document.sourceFile || '',
          sourceSubject: document.sourceSubject || '',
          sourceFrom: document.sourceFrom || '',
          sourceDate: document.sourceDate || '',
          sourceUid: document.sourceUid || '',
          kind: document.kind || '',
          rows,
          pageCount: document.pageCount || 0,
        },
      ],
      bodyPlain: '',
      agentRuns: [],
      paymentAdvice: {
        utr: extractUtrFromNarration(isExcel ? firstExcelRow['UTR Details'] : firstRow.UTR_No),
        amount: isExcel
          ? parseAmount(
            pickAmountFromRow(excelTotalRow, { maxTier: 6 })?.value
          )
          : parseAmount(firstRow.Remittance_Amount),
        paymentDate: isExcel
          ? firstExcelRow['Collection Date'] || document.sourceDate || ''
          : document.sourceDate || '',
        paymentMethod: 'Bank Transfer',
        remitterName: isExcel ? firstExcelRow['Client Name'] || '' : firstRow.Remitter_Name || '',
        clientCode: isExcel
          ? firstExcelRow['Client code'] || firstExcelRow['Client Code'] || ''
          : firstRow.Beneficiary_Name || '',
        confidence: 1,
        extractionMethod: isExcel ? 'excel' : 'api',
        invoiceLines,
        reconciliations: [],
        invoiceNumberValidationFailed,
        invoiceNumberValidationMessage,
        discrepancies: apiErrors
          .filter((error) => error.sourceUid === document.sourceUid)
          .map((error, index) => ({
            id: error.id ?? `${document.sourceUid}_${index}`,
            file: error.file ?? document.sourceFile ?? 'Unknown File',
            type: error.type ?? 'API_ERROR',
            severity: error.severity ?? 'critical',
            title: error.title ?? error.message ?? 'Processing Error',
            description:
              error.description ?? error.message ?? 'An error occurred while processing the file',
            stage: error.stage ?? '',
            status: error.status ?? 'open',
          })),
        notificationDraft: '',
        notificationMethod: '',
      },
    };
  });
}

/** Calls the downstream Save API for a single email's payment advice */
async function submitEmail(email) {
  return submitARPaymentDetails(email);
}

/** Checks that mail_subject */
function findMissingMailFields(email) {
  const missing = [];

  const subject = (email.subject || email.attachments?.[0]?.sourceSubject || '').trim();
  if (!subject) missing.push('mail_subject');

  const sourceFrom = (email.fromAddress || email.attachments?.[0]?.sourceFrom || '').trim();
  const mailEmail = extractEmailAddress(sourceFrom);
  if (!mailEmail) missing.push('mail_email');

  const mailDate = (email.receivedAt || email.attachments?.[0]?.sourceDate || '').trim();
  if (!mailDate) missing.push('mail_date');

  return missing;
}

/** Ported from the frontend's saveFetchedEmails() */
async function saveFetchedEmails(emails, apiErrors) {
  const skipped = [];
  const submitted = [];
  const failed = [];

  if (emails.length === 0) {
    return { submitted, skipped, failed };
  }

  for (const email of emails) {
    const confidence = (email.paymentAdvice?.confidence ?? 0) * 100;
    const sourceFile = email.attachments?.[0]?.sourceFile;
    const sourceUid = email.attachments?.[0]?.sourceUid;

    // Match on sourceUid (unique per attachment: messageUid:partId) AND filename together
    const matchingError = apiErrors.find(
      (error) =>
        error.level === 'error' &&
        !!error.sourceUid &&
        error.sourceUid === sourceUid &&
        (error.file === sourceFile || error.file === email.sourceFile)
    );

    if (matchingError) {
      const fileName = matchingError.file || email.sourceFile || sourceFile || 'Unknown File';
      const errorMessage =
        matchingError.message || matchingError.description || 'An error occurred while processing this file.';

      skipped.push({ file: fileName, reason: errorMessage });
      logger.info(`Save skipped for file: ${fileName}`, { reason: errorMessage });
      continue;
    }

    const invoiceLines = email.paymentAdvice?.invoiceLines ?? [];
    if (invoiceLines.length === 0) {
      const fileName = email.sourceFile || sourceFile || 'Unknown File';

      // Use the validation flag set by aiExtractionService first
      if (email.paymentAdvice?.invoiceNumberValidationFailed) {
        const message = email.paymentAdvice.invoiceNumberValidationMessage;
        const existingDiscrepancies = email.paymentAdvice.discrepancies ?? [];
        const alreadyCaptured = existingDiscrepancies.some((d) => d.description === message);

        if (message && !alreadyCaptured) {
          email.paymentAdvice.discrepancies = [
            ...existingDiscrepancies,
            { file: fileName, description: message }
          ];
        }

      } else {
        // Fall back to checking whether we already know the ACTUAL reason there are no lines some other
        const existingDiscrepancies = email.paymentAdvice?.discrepancies ?? [];
        const relatedApiErrors = apiErrors.filter(
          (error) =>
            (error.file === sourceFile || error.file === email.sourceFile)
        );

        if (existingDiscrepancies.length === 0 && relatedApiErrors.length === 0) {
          // Genuinely no known cause — the document extracted cleanly but just has zero invoice lines
          const reason = 'No invoice lines found in extracted data.';

          // Don't skip — submit with an empty ARInvoiceDetails array
          email.paymentAdvice = email.paymentAdvice ?? {};
          email.paymentAdvice.discrepancies = [...existingDiscrepancies, { file: fileName, description: reason }];
          logger.info(
            `No invoice lines found for file: ${fileName} — submitting anyway with generic error message`,
            { reason }
          );
        } else {
          // A real, specific reason already exists
          const alreadyCaptured = new Set(existingDiscrepancies.map((d) => d.description));
          const missing = relatedApiErrors
            .filter((error) => !alreadyCaptured.has(error.message))
            .map((error) => ({
              file: error.file ?? fileName,
              description: error.message ?? 'An error occurred while processing this file.'
            }));

          if (missing.length > 0) {
            email.paymentAdvice.discrepancies = [...existingDiscrepancies, ...missing];
          }

        }
      }
    }

    const missingMailFields = findMissingMailFields(email);
    if (missingMailFields.length > 0) {
      const fileName = email.sourceFile || sourceFile || 'Unknown File';
      const reason = `Missing required field(s): ${missingMailFields.join(', ')}.`;
      skipped.push({ file: fileName, reason });
      logger.warn(`Save skipped for file: ${fileName} — ${reason}`, {
        missingMailFields,
        subject: email.subject,
        fromAddress: email.fromAddress,
        receivedAt: email.receivedAt
      });
      continue;
    }

    if (confidence >= MIN_AUTO_SUBMIT_CONFIDENCE) {
      try {
        await submitEmail(email);
        submitted.push(email.sourceFile || sourceFile || email.id);
      } catch (error) {
        logger.error(`Auto submit failed for ${email.id}`, { error: error.message, code: error.code });
        recordFailedSubmission(email, error);
        failed.push({ file: email.sourceFile || sourceFile, message: error.message });
      }
    } else {
      const reason = `Confidence is ${confidence}%. Minimum required confidence is ${MIN_AUTO_SUBMIT_CONFIDENCE}%.`;
      skipped.push({ file: email.sourceFile || sourceFile || 'Unknown File', reason });
    }
  }

  return { submitted, skipped, failed };
}

/** Full end-to-end run */
export async function runEmailProcessingJob(filters = { maxResults: 25 }) {
  const start = Date.now();
  let client;

  try {
    client = await connectOutlook();
  } catch (err) {
    logger.error('Outlook connect failed (cron)', err);
    throw err;
  }

  try {
    const { messages, documents, errors } = await runExtractionPipeline(client, filters);
    const collected = mapDocumentsToEmails(documents, errors);

    validateResponse(documents, errors);

    if (messages.length === 0) {
      logger.info('Cron run: no new matching emails — nothing to process', {
        tookMs: Date.now() - start,
      });
      return {
        status: 'no-mail',
        submitted: [],
        skipped: [],
        failed: [],
        messageCount: 0,
        documentCount: 0,
        errorCount: 0,
      };
    }

    if (documents.length === 0) {
      const message = `${messages.length} message(s) matched but nothing could be extracted from any of them (${errors.length} error(s)/warning(s) — see log above for details).`;
      // This IS a real problem (unlike 'no-mail' above)
      logger.error(message, { messageCount: messages.length, errorCount: errors.length });
      logger.error('Extraction errors/warnings:', { errors });
      logger.error('messages extracted:', { messages });
    }

    const result = await saveFetchedEmails(collected, errors);

    // Skipped items (low confidence, missing fields, password-protected, ...) are not retried
    for (const s of result.skipped ?? []) {
      const email = collected.find((e) => e.sourceFile === s.file);
      recordNeedsReview({
        kind: 'skipped',
        file: s.file,
        reason: s.reason,
        subject: email?.subject,
        from: email?.fromAddress,
        receivedAt: email?.receivedAt
      });
    }

    logger.info('Cron email processing run completed', {
      tookMs: Date.now() - start,
      messageCount: messages.length,
      documentCount: documents.length,
      submitted: result.submitted.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    });

    return {
      status: 'completed',
      messageCount: messages.length,
      documentCount: documents.length,
      errorCount: errors.length,
      ...result,
    };
  } catch (err) {
    logger.error('Email processing run failed unexpectedly', err);
    throw err;
  } finally {
    if (client) {
      await client.logout().catch(() => { });
    }
  }
}