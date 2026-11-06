import { postWithAuth } from './authenticatedClient.js';
import { logger } from '../logger.js';
const SAVE_ENDPOINT = process.env.AR_SAVE_ENDPOINT || 'ARKnockOff/SaveARDetails';
// The save endpoint can be slower than the other API calls, so it gets its own (longer) timeout
const SAVE_TIMEOUT_MS = Number(process.env.AR_SAVE_TIMEOUT_MS) || 90000;

/** Pulls the bare email address out of a "Name <address@domain>" */
export function extractEmailAddress(from) {
  if (!from) return '';
  const angleMatch = from.match(/<([^<>]+)>/);
  const candidate = angleMatch ? angleMatch[1] : from;
  const emailMatch = candidate.match(/[^\s<>]+@[^\s<>]+\.[^\s<>]+/);
  return emailMatch ? emailMatch[0].trim() : '';
}

/** Formats a date */
function toISTDateString(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Joins one document's discrepancies */
function buildErrorMessage(discrepancies) {
  return (discrepancies || [])
    .map((d) => d.description || d.title || '')
    .filter(Boolean)
    .join('; ');
}

/** Submits one email's payment advice to the AR KnockOff API */
export async function submitARPaymentDetails(email) {
  const pa = email.paymentAdvice;

  if (!pa) {
    logger.error('Payment advice details are not available', { emailId: email?.id, file: email?.sourceFile });
    throw new Error('Payment advice details are not available');
  }

  const sourceFrom = email.fromAddress || email.attachments?.[0]?.sourceFrom || '';
  const mailDate = email.receivedAt || email.attachments?.[0]?.sourceDate || '';
  const mailSubject = email.subject || email.attachments?.[0]?.sourceSubject || '';
  const fileName = email.sourceFile || email.attachments?.[0]?.sourceFile || '';

  const payload = {
    Batch_Id: email.id?.toString(),
    ARPaymentDetails: [
      {
        UTR_No: pa.utr || '',
        Remittance_Date: toISTDateString(pa.paymentDate) || pa.paymentDate || '',
        Remitter: pa.remitterName || '',
        Benificiary: pa.clientCode || '',
        Total_Remitted_Amount: pa.amount || 0,
        Sender_Mail: extractEmailAddress(sourceFrom),
        Mail_Subject: mailSubject,
        Mail_Date: toISTDateString(mailDate),
        Error_Message: buildErrorMessage(pa.discrepancies),
        FileName: fileName,
        ARInvoiceDetails: (pa.invoiceLines || []).map((invoice) => ({
          Invoice_Number: invoice.invoiceNo || '',
          Amount: invoice.amount?.toString() || '',
          tDS_Amount: invoice.tDS_Amount?.toString() || '',
          tDS_Percent: invoice.tDS_Percent?.toString() || '',
        })),
      },
    ],
  };
  logger.info(`Submitting AR payment details`, { batchId: payload.Batch_Id, file: fileName , payload });
  return postWithAuth(SAVE_ENDPOINT, payload, { timeout: SAVE_TIMEOUT_MS });
}