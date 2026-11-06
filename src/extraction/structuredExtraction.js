import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

/** Generic "document understanding" schema */
const DocumentExtractionSchema = z.object({
  documentType: z
    .string()
    .describe(
      'Best-guess category of the document, e.g. "invoice", "receipt", "purchase order", ' +
        '"bank statement", "contract", "letter", "report", "form", "csv/tabular data", "other".'
    ),
  summary: z.string().describe('One or two sentence plain-English summary of the document.'),
  documentDate: z
    .string()
    .nullable()
    .describe('The primary date printed on the document, formatted YYYY-MM-DD if determinable, else null.'),
  parties: z
    .array(
      z.object({
        role: z.string().describe('e.g. "vendor", "buyer", "sender", "recipient", "employer"'),
        name: z.string()
      })
    )
    .describe('People or organizations named in the document, with their role.'),
  amounts: z
    .array(
      z.object({
        label: z.string().describe('e.g. "subtotal", "tax", "total", "amount due", "balance"'),
        value: z.string().describe('The amount as printed, including currency symbol if present.')
      })
    )
    .describe('Monetary amounts found in the document.'),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        quantity: z.string().nullable(),
        unitPrice: z.string().nullable(),
        total: z.string().nullable()
      })
    )
    .describe('Itemized line items/products/rows, if this document has a table of them (including plain CSV rows).'),
  keyValuePairs: z
    .record(z.string())
    .describe('Any other important field/value pairs found (invoice number, account number, due date, etc).'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('Your confidence that the extraction above is accurate given the source text quality.')
});

/** Thrown for any failure while talking to the LLM */
export class StructuredExtractionError extends Error {
  constructor(message, { cause, retryable = false } = {}) {
    super(message);
    this.name = 'StructuredExtractionError';
    this.cause = cause;
    this.retryable = retryable;
  }
}

let modelSingleton = null;
function getModel() {
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY is not configured. Set it in .env to enable structured extraction.');
  }
  if (!modelSingleton) {
    modelSingleton = new ChatOpenAI({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      temperature: 0
    }).withStructuredOutput(DocumentExtractionSchema, { name: 'extract_document_data' });
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
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('network');
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
}

/** Runs raw text (PDF text-layer output, or CSV file contents) through an OpenAI model via */
export async function extractStructuredData(rawText, context = {}) {
  const model = getModel();
  const truncated =
    rawText.length > MAX_INPUT_CHARS ? `${rawText.slice(0, MAX_INPUT_CHARS)}\n...[truncated]` : rawText;

  if (!truncated.trim()) {
    return {
      documentType: 'unknown',
      summary: 'No extractable text was found in this document.',
      documentDate: null,
      parties: [],
      amounts: [],
      lineItems: [],
      keyValuePairs: {},
      confidence: 'low'
    };
  }

  return withRetries(
    () =>
      model.invoke([
        [
          'system',
          'You extract structured data from email attachments (invoices, receipts, statements, ' +
            'letters, forms, reports, CSV/tabular exports, etc). Read the provided text — which may ' +
            'come from a PDF text layer or a raw CSV file and can contain noise/artifacts — and ' +
            'populate the fields as accurately as possible. For tabular/CSV data, map rows into ' +
            'lineItems. Never invent data that is not present in the text; use null / empty arrays ' +
            'for anything you cannot find.'
        ],
        [
          'human',
          `Source filename: ${context.filename ?? 'unknown'}\nEmail subject: ${context.subject ?? ''}\n\n` +
            `Document text:\n"""\n${truncated}\n"""`
        ]
      ]),
    `OpenAI structured extraction for "${context.filename ?? 'unknown'}"`
  );
}

/** Vision variant: sends image bytes straight to the OpenAI model */
export async function extractStructuredDataFromImage(buffer, mimeType, context = {}) {
  const model = getModel();
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType || 'image/png'};base64,${base64}`;

  return withRetries(
    () =>
      model.invoke([
        [
          'system',
          'You extract structured data from images of email attachments (invoices, receipts, ' +
            'statements, letters, forms, screenshots, etc). Read the image carefully, including any ' +
            'tables, stamps, or handwriting, and populate the fields as accurately as possible. Never ' +
            'invent data that is not present in the image; use null / empty arrays for anything you ' +
            'cannot find.'
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
}
