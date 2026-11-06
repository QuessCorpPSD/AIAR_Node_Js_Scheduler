
export const DEFAULT_AMOUNT_PRIORITY_TIERS = [
  // 1st priority
  [
    'Received Amount', 'Amount Received', 'Payment Amount', 'Amount Paid', 'Paid Amount',
    'Remittance Amount', 'Remitted Amount', 'Amount Remitted', 'Transaction Amount', 'Transfer Amount'
  ],
  // 2nd priority
  ['Net Pay', 'Net Payable', 'Net Paid', 'Net Amount', 'Net Payment', 'Net Payment Amount', 'Net Remittance', 'Net Remitted Amount'],
  // 3rd priority
  ['Settlement Amount', 'Settled Amount', 'Amount Settled', 'Total Payment', 'Total Paid', 'Total Remittance', 'Payment Total', 'Remittance Total'],
  // 4th priority
  ['Credit Amount', 'Amount Credited', 'Credited Amount', 'Credit Value', 'Payment Value', 'Remittance Value', 'Final Payment Amount'],
  // 5th priority
  ['Receivable Amount', 'Receivable Amt', 'Amount Receivable'],
  // 6th priority
  ['Payable Amount', 'Amount Payable', 'Payable Amt', 'Final Amount'],
  // 7th priority (generic)
  ['Amount', 'Amt', 'Total Amount', 'Total']
];

// Live tiers
let AMOUNT_PRIORITY_TIERS = DEFAULT_AMOUNT_PRIORITY_TIERS;

/** Lower-cases and collapses punctuation/whitespace */
export function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// normalized header -> tier number (1-based)
let HEADER_TO_TIER = new Map();

function rebuildTierLookups() {
  HEADER_TO_TIER = new Map();
  AMOUNT_PRIORITY_TIERS.forEach((names, i) => {
    for (const n of names) {
      const k = normalizeHeader(n);
      if (!HEADER_TO_TIER.has(k)) HEADER_TO_TIER.set(k, i + 1);
    }
  });
}

/** Replaces the amount priority tiers */
export function setAmountPriorityTiers(tiers) {
  const valid =
    Array.isArray(tiers) && tiers.length > 0 && tiers.every((t) => Array.isArray(t) && t.length > 0);
  AMOUNT_PRIORITY_TIERS = valid ? tiers : DEFAULT_AMOUNT_PRIORITY_TIERS;
  rebuildTierLookups();
}

/** Tier (1-7) of a column header, or 0 when it is not an amount header */
function amountTierOfHeader(header) {
  return HEADER_TO_TIER.get(normalizeHeader(header)) ?? 0;
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Picks the invoice amount from a spreadsheet row object by tier priority */
export function pickAmountFromRow(row, { maxTier = AMOUNT_PRIORITY_TIERS.length } = {}) {
  if (!row || typeof row !== 'object') return null;
  let best = null;
  for (const key of Object.keys(row)) {
    const tier = amountTierOfHeader(key);
    if (!tier || tier > maxTier || isBlank(row[key])) continue;
    if (!best || tier < best.tier) best = { value: row[key], header: key, tier };
  }
  return best;
}

// LLM prompt text

const quoteList = (names) => names.map((n) => `"${n}"`).join(', ');

/** Human-readable priority list for LLM prompts / schema descriptions */
export function getAmountPriorityPrompt() {
  return (
  'AMOUNT COLUMN PRIORITY — look at the table headers and use the column from the HIGHEST priority tier that is present; ' +
  'ignore every lower tier when a higher one exists. ' +
  AMOUNT_PRIORITY_TIERS.map((names, i) => `(${i + 1}) ${quoteList(names)}`).join('; ') +
  '. Header names are matched case-insensitively. Never use the Gross/Invoice Amount when any column from tiers 1-6 exists. ' +
  'Copy the value of the chosen column exactly as printed, even if it differs from a neighbouring amount column.'
  );
}

// raw-text header detection (net-pay repair)

rebuildTierLookups();

