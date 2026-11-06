/** UTR handling for bank narrations (e.g. the "UTR Details" column of a bank statement) */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Value sent as UTR_No */
export function extractUtrFromNarration(raw) {
  return clean(raw);
}

/** True when a cell looks like a bank narration */
export function looksLikeNarration(raw) {
  const text = clean(raw);
  if (text.length < 10) return false;
  if (/^(IMPS|UPI|NEFT|RTGS|CLG|CMS|FT|BY\s+TRANSFER|MMT|ACH|ECS|INF|CHQ|CHEQUE)(?![A-Za-z])[\s\/*:-]/i.test(text)) return true;
  if (/^[24]\d{5,}[-\/\s]\S/.test(text)) return true;
  // Generic multi-segment string
  return (
    text.length >= 20 &&
    /[A-Za-z]/.test(text) &&
    (text.match(/[\/*]/g) || []).length >= 2 &&
    (text.match(/\d/g) || []).length >= 8
  );
}
