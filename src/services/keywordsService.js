import { subjectAxiosInstance } from './apiClient.js';
import { logger } from '../logger.js';
import { DEFAULT_AMOUNT_PRIORITY_TIERS, setAmountPriorityTiers } from '../utils/amountPriority.js';

// Same host/base URL as the skipped-subjects lookup
const KEYWORDS_PATH = process.env.AI_KEYWORDS_PATH || 'ARKnockOff/GetAllIgnoreSubjectLine';

/** Keyword lists used to steer the AI extraction */
const DEFAULT_KEYWORDS = {
  utr: ['UTR No', 'Other Reference', 'UTR/RRN No', 'UTR', 'RRN', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'CMS-TPT', 'CLG', 'BY TRANSFER'],
  beneficiary: ['Beneficiary', 'Payee', 'A/c No', 'Account Number', 'Beneficiary Name', 'Beneficiary Bank'],
  totalRemittedAmount: ['remitted', 'transferred amount'],
  invoiceNumber: [
    'Invoice Number', 'Invoice No', 'Invoice Ref', 'Invoice', 'Invoice #',
    'Document Number', 'Document No', 'Document #', 'Doc Number', 'Doc No', 'Doc #'
  ],
  amountTiers: DEFAULT_AMOUNT_PRIORITY_TIERS,
  tdsAmount: ['TDS', 'TDS Amount', 'Deduction'],
  tdsPercent: ['TDS %', 'TDS Percentage', 'TDS Rate']
};

let current = { ...DEFAULT_KEYWORDS };
let signature = 'default';

/** Current keyword config (API values when loaded, otherwise the defaults) */
export function getKeywordConfig() {
  return current;
}

/** Changes whenever the keyword config changes — used to rebuild the LLM model/schema */
export function getKeywordSignature() {
  return signature;
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAmountTiers(value) {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const tiers = [];
  for (const chunk of text.split(';')) {
    const m = chunk.match(/^\s*Priority\s*(\d+)\s*:\s*(.*)$/is);
    const list = splitList(m ? m[2] : chunk);
    if (!list.length) continue;
    const idx = m ? Number(m[1]) - 1 : tiers.length;
    tiers[idx] = list;
  }
  // collapse holes (e.g. Priority 1 and 3 present, 2 missing)
  return tiers.filter(Boolean);
}

/** Maps one API row (UTR_No_keywords, Benificiary_keywords, ...) to the config shape */
function parseKeywordRow(row) {
  const pick = (parsed, fallback) => (parsed.length ? parsed : fallback);

  // Tiers the API doesn't send (or sends fewer of) fall back to the defaults
  const apiTiers = parseAmountTiers(row.Amount_keywords);
  const amountTiers = DEFAULT_AMOUNT_PRIORITY_TIERS.map((def, i) => apiTiers[i] ?? def);
  for (let i = DEFAULT_AMOUNT_PRIORITY_TIERS.length; i < apiTiers.length; i++) amountTiers.push(apiTiers[i]);

  return {
    utr: pick(splitList(row.UTR_No_keywords), DEFAULT_KEYWORDS.utr),
    beneficiary: pick(splitList(row.Benificiary_keywords), DEFAULT_KEYWORDS.beneficiary),
    totalRemittedAmount: pick(splitList(row.Total_Remitted_Amount_keywords), DEFAULT_KEYWORDS.totalRemittedAmount),
    invoiceNumber: pick(splitList(row.Invoice_Number_keywords), DEFAULT_KEYWORDS.invoiceNumber),
    amountTiers,
    tdsAmount: pick(splitList(row.TDS_Amount_keywords), DEFAULT_KEYWORDS.tdsAmount),
    tdsPercent: pick(splitList(row.TDS_Percent_keywords), DEFAULT_KEYWORDS.tdsPercent)
  };
}

function extractRows(body) {
  const data = body?.Data ?? body;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.Table)) return data.Table;
  if (data && typeof data === 'object' && ('UTR_No_keywords' in data || 'Amount_keywords' in data)) return [data];
  return [];
}

// Always the FIRST entry of Data.Table (array [0])
function pickRow(rows) {
  return rows[0] ?? null;
}

/** Fetches the keyword row from the API and applies it (prompt keywords + amount tiers) */
export async function refreshExtractionKeywords() {
  try {
    const response = await subjectAxiosInstance.get(KEYWORDS_PATH);
    const body = response.data;

    if (body && typeof body === 'object' && !Array.isArray(body) && (body.StatusCode !== undefined) && (body.StatusCode !== 200 || body.Error)) {
      logger.warn('Keywords API returned an error response — keeping current keywords', {
        path: KEYWORDS_PATH,
        statusCode: body.StatusCode,
        error: body.Error
      });
      return current;
    }

    const row = pickRow(extractRows(body));
    if (!row) {
      logger.warn('Keywords API returned no row at Data.Table[0] — keeping current keywords', { path: KEYWORDS_PATH });
      return current;
    }

    const next = parseKeywordRow(row);
    const nextSignature = `${row.id ?? 'x'}:${JSON.stringify(next)}`;
    if (nextSignature !== signature) {
      current = next;
      signature = nextSignature;
      setAmountPriorityTiers(next.amountTiers);
      logger.info('Loaded extraction keywords from API', { id: row.id, createdOn: row.CreatedOn });
    }
    return current;
  } catch (err) {
    logger.warn('Failed to fetch extraction keywords from API — keeping current keywords', {
      path: KEYWORDS_PATH,
      error: err.message
    });
    return current;
  }
}
