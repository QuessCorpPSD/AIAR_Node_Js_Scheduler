import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { getAmountPriorityPrompt } from '../utils/amountPriority.js';
import { getKeywordConfig, getKeywordSignature } from './keywordsService.js';
import { logger } from '../logger.js';


function isVisionCapable() {
  return String(process.env.OPENAI_VISION_CAPABLE ?? '').trim().toLowerCase() === 'true';
}

// Accepted invoice formats: 2 letters + 6 digits, CNGJ/<n>/<n>, or NO_REF_DOC
const INVOICE_NUMBER_PATTERN = /^([A-Za-z]{2}\d{6}|CNGJ\/\d+\/\d+|NO_REF_DOC)$/;

/** Payment-remittance extraction schema */
function buildDocumentExtractionSchema() {
  return z.object({
  Beneficiary_Name: z.string().nullable().describe('The beneficiary/payee name.'),
  Beneficiary_Bank: z.string().nullable().describe('The beneficiary bank name.'),
  Beneficiary_Account: z.string().nullable().describe('The beneficiary account number, preserved exactly as printed.'),
  Customer_Reference: z.string().nullable().describe('The customer reference, if present.'),
  Debit_Amount: z
    .string()
    .nullable()
    .describe('The amount debited from the sender, currency symbol removed but decimal value preserved.'),
  Remittance_Amount: z
    .string()
    .nullable()
    .describe('The remitted/transferred amount, currency symbol removed but decimal value preserved.'),
  Remitter_Name: z.string().nullable().describe('The sender/remitter name.'),
  Remitting_Bank: z.string().nullable().describe("The sender's bank name."),
  UTR_No: z
    .string()
    .nullable()
    .describe('The UTR number. If "UTR No" is not present on the document, use the value from "Other Reference" instead.'),
  Invoices: z
    .array(
      z.object({
        Invoice_Number: z
          .string()
          .nullable()
          .describe(
            'A value found anywhere in a table/tabular block that matches ANY of: exactly two letters ' +
              'followed by six digits (e.g. "HR902992"), the CNGJ credit-note/reversal format ' +
              '"CNGJ/<digits>/<digits>" (e.g. "CNGJ/2627/10055"), or the literal placeholder "NO_REF_DOC". ' +
              'Match by this pattern first. If the table has both an "Invoice Number"/"Invoice Ref" column and a separate ' +
              '"Document Number" column, take the value from the Invoice column only. Otherwise the column may be labeled "Document Number", ' +
              '"Invoice Number", "Invoice Ref", or many other variants, so do not rely on the header text alone. Do not ' +
              'include values that match none of these patterns. Never exclude a record just because its ' +
              'Amount is negative — negative amounts (credits/reversals/unreferenced debits, e.g. CNGJ or ' +
              'NO_REF_DOC rows) must still be included if the number matches.'
          ),
        Amount: z
          .string()
          .nullable()
          .describe(
            'The amount belonging to the same record as this Invoice_Number (same row, or — if the table ' +
              'text is wrapped across multiple lines per record — the value in the equivalent column ' +
              'position within that record\'s lines), currency symbol removed but decimal value preserved, ' +
              'INCLUDING the leading minus sign if the amount is negative. ' +
              getAmountPriorityPrompt() + ' ' +
              'Copy every digit as printed (e.g. "391127.1" stays "391127.1", ' +
              'never "391127"). No calculations.'
          ),
        TDS: z
          .string()
          .describe(
            'The TDS (Tax Deducted at Source) amount belonging to the same record as this Invoice_Number ' +
              '(same row, or the corresponding line if the record is wrapped across multiple lines), if a ' +
              '"TDS", "TDS Amount","Deduction", or similarly-named value is present for it. Currency symbol removed but ' +
              'decimal value preserved, including a leading minus sign if shown negative. Use an empty ' +
              'string "" if the document has no TDS value at all, or if this specific record has no value ' +
              'in it. No calculations.'
          ),
        TDS_Percentage: z
          .string()
          .describe(
            'The TDS rate/percentage belonging to the same record as this Invoice_Number (same row, or the ' +
              'corresponding line if the record is wrapped across multiple lines), if a "TDS %", "TDS ' +
              'Percentage", "TDS Rate", or similarly-named value is present (e.g. "2%", "10%"). Preserve ' +
              'exactly as printed, including the "%" sign. Use an empty string "" if the document has no ' +
              'TDS percentage value at all, or if this specific record has no value in it. No calculations.'
          )
      })
    )
    .describe(
      'One entry per record in the document whose Invoice_Number matches one of the required patterns ' +
        '(two-letters+six-digits, CNGJ/<digits>/<digits>, or the literal "NO_REF_DOC") — match by pattern ' +
        'first, not by column header text, since header names vary by sender. A record is normally one ' +
        'table row, but when the table text is wrapped across multiple lines (common when an HTML table is ' +
        'converted to plain text — e.g. one line holding Invoice Number/Date/Net Amount/TCS and the next ' +
        'line holding that same record\'s TDS/Site Code/Site Name), treat those consecutive lines as one ' +
        'record and take Invoice_Number, Amount, TDS, and TDS_Percentage from the matching positions across ' +
        'them, in the order records appear in the document. Records with a negative Amount ' +
        '(credits/reversals) must still be included, never skipped. TDS and TDS_Percentage are only present ' +
        'on some documents — use an empty string "" for either when not present for a given record.'
    )
  });
}

/** Thrown for any failure while talking to the LLM */
class StructuredExtractionError extends Error {
  constructor(message, { cause, retryable = false } = {}) {
    super(message);
    this.name = 'StructuredExtractionError';
    this.cause = cause;
    this.retryable = retryable;
  }
}

// Strip a trailing /chat/completions
function toBaseURL(url) {
  return url.replace(/\/chat\/completions\/?$/i, '');
}

let modelSingleton = null;
let modelSignature = null;
let configuredModelName = null;
function getModel() {
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY is not configured. Set it in .env to enable structured extraction.');
    throw new StructuredExtractionError(
      'OPENAI_API_KEY is not configured. Set it in .env to enable structured extraction.'
    );
  }
  // Rebuilt whenever the keywords from the API change
  const signatureNow = getKeywordSignature();
  if (!modelSingleton || modelSignature !== signatureNow) {
    modelSignature = signatureNow;
    // gpt-4o-mini is the default
    configuredModelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // Optional: point at an OpenAI-compatible endpoint other than api.openai.com
    const baseURL = process.env.OPENAI_BASE_URL ? toBaseURL(process.env.OPENAI_BASE_URL) : undefined;

    modelSingleton = new ChatOpenAI({
      model: configuredModelName,
      temperature: 0, // deterministic extraction, not creative generation
      apiKey: process.env.OPENAI_API_KEY,
      // Cap timeout/retries so one stalled call can't hold the cron run
      timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 90000,
      maxRetries: Number.isNaN(Number.parseInt(process.env.OPENAI_MAX_RETRIES, 10))
        ? 1
        : Number.parseInt(process.env.OPENAI_MAX_RETRIES, 10),
      ...(baseURL ? { configuration: { baseURL } } : {})
    }).withStructuredOutput(buildDocumentExtractionSchema(), { name: 'extract_document_data' });
  }
  return modelSingleton;
}

// Keep prompts within a sane token budget
const MAX_INPUT_CHARS = 20000;

const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES
const RETRY_BASE_DELAY_MS = 800;

function isRetryableError(err) {
  // OpenAI/LangChain surface HTTP-ish errors with a status/code where available
  const status = err?.status ?? err?.response?.status ?? err?.code;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  // The OpenAI SDK words its timeout "Request timed out."
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('network')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn` with a small number of retries for transient failures */
async function withRetries(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < MAX_RETRIES && isRetryableError(err);
      if (!canRetry) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  logger.error(`Structured extraction failed for "${label}"`, { error: lastErr });
  throw new StructuredExtractionError(`${label} failed: ${lastErr.message}`, {
    cause: lastErr,
    retryable: isRetryableError(lastErr)
  });
}

// Re-validate invoice numbers; the LLM can slip on regex constraints
function enforceInvoiceNumberPattern(result, context = {}) {
  if (result && Array.isArray(result.Invoices)) {
    const kept = [];
    const dropped = [];
    for (const row of result.Invoices) {
      // Force TDS fields to "" instead of null/undefined
      if (row && typeof row === 'object') {
        if (row.TDS === null || row.TDS === undefined) row.TDS = '';
        if (row.TDS_Percentage === null || row.TDS_Percentage === undefined) row.TDS_Percentage = '';
      }
      const num = row?.Invoice_Number;
      if (typeof num === 'string' && INVOICE_NUMBER_PATTERN.test(num)) {
        kept.push(row);
      } else {
        dropped.push(num ?? null);
      }
    }
    result.Invoices = kept;
    if (dropped.length > 0) {
      const message =
        'Invalid Invoice Number - This is not part of Quess invoices : ' +
        dropped.map((v) => (v === null ? 'null' : JSON.stringify(v))).join(', ');

      if (Array.isArray(context.errors)) {
        context.errors.push({
          file: context.filename ?? 'unknown',
          stage: 'validate',
          message,
          sourceUid: context.sourceUid ?? null,
          level: 'warning'
        });
      }

      // Flag it directly on the result too (not just in context.errors)
      result.invoiceNumberValidationFailed = true;
      result.invoiceNumberValidationMessage = message;
    }
  }
  return result;
}

// Beneficiary names that indicate the document belongs to a different Quess-group entity's
const NON_QUESS_BENEFICIARY_NAMES = ['BLUSPRING', 'ALLDIGI', 'DIGITIDE'];

// Flags (rather than drops) a document whose Beneficiary_Name belongs to a known non-Quess entity
function enforceQuessBeneficiary(result, context = {}) {
  const name = result?.Beneficiary_Name;
  if (typeof name === 'string') {
    const upper = name.toUpperCase();
    const matched = NON_QUESS_BENEFICIARY_NAMES.find((bad) => upper.includes(bad));
    if (matched && Array.isArray(context.errors)) {
      context.errors.push({
        file: context.filename ?? 'unknown',
        stage: 'validate',
        message: `Invalid Invoice Number - This is not part of Quess invoices : "${name}"`,
        sourceUid: context.sourceUid ?? null,
        level: 'warning'
      });
    }
  }
  return result;
}

 // requires a decimal point: ignores dates and long doc numbers

const EMPTY_RESULT = {
  Beneficiary_Name: null,
  Beneficiary_Bank: null,
  Beneficiary_Account: null,
  Customer_Reference: null,
  Debit_Amount: null,
  Remittance_Amount: null,
  Remitter_Name: null,
  Remitting_Bank: null,
  UTR_No: null,
  Invoices: []
};

const quoted = (list) => list.map((k) => `"${k}"`).join(', ');

/** Label hints from the keywords API (see services/keywordsService.js) */
function buildKeywordHints() {
  const k = getKeywordConfig();
  return (
    '\n\nKEYWORD MAPPING — labels, headers and phrases that identify each field (matched case-insensitively; ' +
    'senders use these or close variants). These hints take precedence over any shorter label list above; ' +
    'they do not relax the Invoice_Number pattern rules or the "do not guess" rule.\n' +
    `- UTR_No: ${quoted(k.utr)}. A value next to one of these labels, or a narration starting with one of the channel names (NEFT, RTGS, IMPS, UPI, CMS-TPT, CLG, BY TRANSFER), is the UTR_No.\n` +
    `- Beneficiary_Name / Beneficiary_Bank / Beneficiary_Account: ${quoted(k.beneficiary)}.\n` +
    `- Remittance_Amount: ${quoted(k.totalRemittedAmount)} (the total for the whole payment, not a single invoice line).\n` +
    `- Invoices[].Invoice_Number: column headers such as ${quoted(k.invoiceNumber)} (the pattern rules still decide which values are valid).\n` +
    `- Invoices[].TDS: ${quoted(k.tdsAmount)}.\n` +
    `- Invoices[].TDS_Percentage: ${quoted(k.tdsPercent)}.`
  );
}

function buildFieldExtractionRules() {
  return (
  'Field extraction rules:\n' +
  '- Beneficiary_Name: the beneficiary/payee name.\n' +
  '- Beneficiary_Bank: the beneficiary bank name.\n' +
  '- Beneficiary_Account: the beneficiary account number, exactly as printed.\n' +
  '- Customer_Reference: the customer reference, if available.\n' +
  '- Debit_Amount: the amount debited from the sender.\n' +
  '- Remittance_Amount: the remitted/transferred amount.\n' +
  '- Remitter_Name: the sender/remitter name.\n' +
  '- Remitting_Bank: the sender\'s bank name.\n' +
  '- UTR_No: the UTR number; if "UTR No" is not present, use the value from "Other Reference" instead. ' +
  'If the value is a bank narration / transaction description (e.g. ' +
  '"IMPS/P2A/622459022440/DHWANITE/HDFCBANK/INVWB903/9198310332169240000", "NEFT/HSBCN28095077564/BLUE STAR LIMITED/...", ' +
  '"UPI/421374299475/From:..."), return the FULL narration string exactly as printed, on one line, not just the reference ' +
  'number inside it. A narration may also START WITH A NUMBER, e.g. "4200044000-07 10 2026-HD00182108" — that whole ' +
  'string is still the UTR_No; return it as-is. Codes inside a narration (e.g. "HD00182108", "BT26100786923309", ' +
  '"RZ1043976375") are part of the UTR_No, NOT invoice numbers — never put them in Invoices. ' +
  'If no UTR / reference / narration is present, leave it empty.\n' +
  '- Invoices: scan every table/tabular block in the document for values matching ANY of these patterns: ' +
  '(a) ^[A-Za-z]{2}\\d{6}$ (exactly two letters then six digits), (b) ^CNGJ\\/\\d+\\/\\d+$ (the CNGJ ' +
  'credit-note/reversal format, e.g. "CNGJ/2627/10055"), or (c) the literal value "NO_REF_DOC". Treat any ' +
  'such value as an Invoice_Number candidate REGARDLESS of what its column is named — column headers vary ' +
  'across senders (seen so far: "Document Number", "Document No.", "Document #", "Doc Number", "Invoice ' +
  'Number", "Invoice No.", "Invoice #", "Invoice Ref","Invoice", and others not listed here) and the pattern match matters far more ' +
  'than the header text. For each candidate, find the Amount belonging to the SAME record — a plain-text ' +
  'rendering of a table (e.g. an email body converted from HTML) is often wrapped, so a single conceptual ' +
  'record can be split across two or more consecutive lines (e.g. one line holding Invoice Number/Date/Net ' +
  'Amount/TCS and the very next line holding that same record\'s TDS/Site Code/Site Name before the next ' +
  'Invoice Number begins) — use column order/position and proximity to group wrapped lines into one record, ' +
  'not just literal same-line text. Extract Amount in the same order as its Invoice_Number, INCLUDING the ' +
  'leading minus sign for negative amounts. Do NOT skip a row just because its Amount is negative — ' +
  'credit/reversal/unreferenced rows (commonly CNGJ or NO_REF_DOC) must still be extracted like any other ' +
  'row. If a record also has a TDS / TDS Amount value and/or a TDS % / TDS Percentage / TDS Rate value ' +
  '(under any column name, by the same pattern-first, position-based matching), take those as TDS and ' +
  'TDS_Percentage respectively; use an empty string "" for either when the document has no such column, or ' +
  'the record has no value in it. ' +
  'STACKED-HEADER TABLES (common in HDFC/bank RTGS-NEFT advice emails): the table may have TWO header lines ' +
  'followed by TWO value lines, e.g.\n' +
  '  Invoice Number | Document Number | Document date | Posting date\n' +
  '  Invoice Amount | Deductions | Net Amount\n' +
  '  MH918201 | 0190032423 | 29/09/2026 | 30/09/2026\n' +
  '  247014.00 | 209.00 | 246805.00\n' +
  'Read the header lines as one column each, stacked: column 1 = Invoice Number over Invoice Amount, column 2 = ' +
  'Document Number over Deductions, column 3 = Document date over Net Amount, column 4 = Posting date. The first value ' +
  'line fills the first header line by position and the second value line fills the second header line. Here the ' +
  'record is Invoice_Number "MH918201", Amount "246805.00" (the Net Amount), with 247014.00 being the gross Invoice Amount ' +
  'and 209.00 the Deductions. ' +
  'When BOTH an "Invoice Number" (or "Invoice Ref") column AND a separate "Document Number" column exist, ' +
  'Invoice_Number comes ONLY from the Invoice Number/Ref column; the Document Number value (e.g. a 10-digit ' +
  '"0190032423") is the bank/payment document reference, NOT an invoice number — never return it as Invoice_Number. ' +
  'Amount is the value of the highest-priority amount column present (see priority list below) — for a Net column it is the NET value (it equals the remitted amount for a single-invoice advice) — NEVER the Gross / Invoice Amount when a tier 1-6 column exists. ' +
  getAmountPriorityPrompt() + ' ' +
  'COLLAPSED-COLUMN ROWS: blank cells (e.g. Advance Amount, TDS, Remarks) vanish in plain text, so a row such as ' +
  '"9022246282 HR907010 30/09/2026 391459.10 332.00 391127.1" is Gross 391459.10, Deduction 332.00, Net 391127.1 ' +
  '(Gross - Deduction = Net, usually the LAST decimal number on the row). Amount = "391127.1", not the Gross. ' +
  'Always copy amounts with every digit as printed — never drop decimals (391127.1 must not become 391127). ' +
  'Put Deductions into TDS only when the column is actually labeled TDS; otherwise leave TDS as an empty string. ' +
  'NARRATIVE-PARAGRAPH ADVICES: when the header details are written as a sentence instead of labeled fields, e.g. ' +
  '"credit through RTGS to your A/c No. 194010200010618 with IFSC Code UTIB0000194 vide UTR/RRN no ' +
  'HDFCR52026100367127504 for Rs 246,805.00", extract Beneficiary_Account = the A/c No. (digits only, as printed), ' +
  'UTR_No = the UTR/RRN number (e.g. "HDFCR52026100367127504"), and Remittance_Amount = the Rs amount with the ' +
  'currency prefix and thousands commas removed ("246805.00"). Beneficiary_Bank is only filled if a bank name is ' +
  'written out in the document (an IFSC code alone is not a name — leave null). ' +
  'If multiple values exist for a field, choose the one that most clearly represents the payment transaction. ' +
  'Preserve names and account numbers exactly as they appear. Do not infer or guess values that are not ' +
  'present; use null for anything you cannot find. Remove currency symbols from amounts but preserve decimal ' +
  'values, and do not perform any calculations.' +
  buildKeywordHints()
  );
}

/** Runs raw text (PDF text-layer output, or CSV file contents) through an OpenAI model via */
export async function extractStructuredData(rawText, context = {}) {
  const model = getModel();
  const truncated =
    rawText.length > MAX_INPUT_CHARS ? `${rawText.slice(0, MAX_INPUT_CHARS)}\n...[truncated]` : rawText;

  if (!truncated.trim()) {
    return { ...EMPTY_RESULT };
  }

  const result = await withRetries(
    () =>
      model.invoke([
        [
          'system',
          'You are an intelligent document extraction system. You extract structured payment-remittance ' +
            'data from email attachments (bank remittance advice, invoices, receipts, payment confirmations, ' +
            'statements, letters, forms, CSV/tabular exports, etc). Read the provided text — which may come ' +
            'from a PDF text layer or a raw CSV file and can contain noise/artifacts — carefully, paying ' +
            'special attention to tables and multi-page documents, and populate the fields as accurately as ' +
            'possible.\n\n' +
            buildFieldExtractionRules()
        ],
        [
          'human',
          `Source filename: ${context.filename ?? 'unknown'}\nEmail subject: ${context.subject ?? ''}\n\n` +
            `Document text:\n"""\n${truncated}\n"""`
        ]
      ]),
    `OpenAI structured extraction for "${context.filename ?? 'unknown'}"`
  );
  enforceQuessBeneficiary(result, context);
  return enforceInvoiceNumberPattern(result, context);
}

/** Vision variant: sends image bytes straight to the OpenAI model */
export async function extractStructuredDataFromImage(buffer, mimeType, context = {}) {
  const model = getModel();
  if (!isVisionCapable()) {
    const message =
      `Configured OPENAI_MODEL "${configuredModelName}" is not marked as vision-capable. ` +
      `Set OPENAI_VISION_CAPABLE=true in .env if this deployment supports image input.`;
    logger.error(message);
    throw new StructuredExtractionError(message);
  }
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType || 'image/png'};base64,${base64}`;

  const result = await withRetries(
    () =>
      model.invoke([
        [
          'system',
          'You are an intelligent document extraction system. You extract structured payment-remittance ' +
            'data from images of email attachments (bank remittance advice, invoices, receipts, payment ' +
            'confirmations, statements, letters, forms, screenshots, stamps, signatures, handwritten notes, ' +
            'scanned pages, etc). Read the image carefully — including any tables, stamps, or handwriting, ' +
            'and OCR it as needed — paying special attention to tables and multi-page documents, and ' +
            'populate the fields as accurately as possible.\n\n' +
            buildFieldExtractionRules()
        ],
        [
          'human',
          [
            {
              type: 'text',
              text: `Source filename: ${context.filename ?? 'unknown'}\nEmail subject: ${context.subject ?? ''}`
            },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        ]
      ]),
    `OpenAI vision extraction for "${context.filename ?? 'unknown'}"`
  );
  enforceQuessBeneficiary(result, context);
  return enforceInvoiceNumberPattern(result, context);
}