import * as XLSX from 'xlsx';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { looksLikeNarration } from '../utils/utrExtractor.js';
import { getKeywordConfig } from '../services/keywordsService.js';

// The regexes below use lazy [\s\S]*?
const MAX_HTML_CHARS = 200000;

export function stripHtml(html) {
  if (!html) return '';
  if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS);
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class PasswordProtectedError extends Error {
  constructor() {
    super('Password protected file cannot read');
    this.name = 'PasswordProtectedError';
  }
}

function isPasswordRelated(err) {
  return err?.name === 'PasswordException' || /password[- ]?protect|encrypted/i.test(String(err?.message ?? ''));
}

export function classifyAttachment(filename, mimeType) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();

  if (ext === 'csv' || mt === 'text/csv') return 'csv';
  if (['xlsx', 'xls', 'xlsm'].includes(ext) || mt.includes('spreadsheet') || mt === 'application/vnd.ms-excel') {
    return 'excel';
  }
  if (ext === 'pdf' || mt === 'application/pdf') return 'pdf';
  if (mt.startsWith('image/')) return 'image';
  if (ext === 'zip' || ZIP_MIME_TYPES.includes(mt)) return 'zip';
  return 'unsupported';
}

const ZIP_MIME_TYPES = [
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'multipart/x-zip'
];

const EXT_TO_MIME = {
  csv: 'text/csv',
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip'
};

/** Files pulled out of a ZIP have no MIME type of their own */
export function mimeTypeFromFilename(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

// Header keywords used to locate the real table header row in a sheet
const EXCEL_HEADER_KEYWORDS = ['invoice number', 'invoice ref', 'client code', 'client name', 'utr details'];

/** Finds the 0-based index of the real table header row */
function findHeaderRowIndex(aoa) {
  const limit = Math.min(aoa.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = (aoa[i] || []).map((c) => String(c ?? '').trim().toLowerCase());
    const hits = cells.filter((c) => EXCEL_HEADER_KEYWORDS.includes(c)).length;
    // invoice-style headers from the keywords API (e.g. "Invoice
    const invoiceHeaders = getKeywordConfig().invoiceNumber.map((h) => h.trim().toLowerCase()).filter((h) => !h.startsWith('doc'));
    if (cells.some((c) => invoiceHeaders.includes(c)) || cells.includes('invoice number') || cells.includes('invoice ref') || hits >= 2) return i;
  }
  return 0;
}

// An .xlsx/.xlsm is a ZIP
const EXCEL_MAX_UNCOMPRESSED_BYTES = Math.max(50, Number(process.env.EXCEL_MAX_UNCOMPRESSED_MB) || 300) * 1024 * 1024;

/** Sum of uncompressed sizes declared in a ZIP's central directory */
function declaredUncompressedBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return null;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) return null;
    total += buffer.readUInt32LE(pos + 24);
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return total;
}

// Hard ceiling on rows read per sheet
const EXCEL_MAX_ROWS = Math.max(1000, Number(process.env.EXCEL_MAX_ROWS) || 100000);

/** Shrinks a sheet's declared range (`!ref`) to the cells that actually exist */
function trimSheetRange(sheet, sheetName) {
  const ref = sheet?.['!ref'];
  if (!ref) return;
  const declared = XLSX.utils.decode_range(ref);
  let maxR = -1;
  let maxC = -1;
  for (const key in sheet) {
    if (key.charCodeAt(0) === 33) continue; // skip !ref, !merges, ..
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR < 0) {
    delete sheet['!ref']; // no cells at all -> sheet_to_json returns []
    return;
  }
  const endR = Math.min(declared.e.r, maxR, declared.s.r + EXCEL_MAX_ROWS - 1);
  const endC = Math.min(declared.e.c, maxC);
  if (maxR > declared.s.r + EXCEL_MAX_ROWS - 1) {
    logger.warn(`Excel sheet "${sheetName}" has more than ${EXCEL_MAX_ROWS} rows — only the first ${EXCEL_MAX_ROWS} are read`);
  }
  if (endR < declared.e.r || endC < declared.e.c) {
    sheet['!ref'] = XLSX.utils.encode_range({ s: declared.s, e: { r: Math.max(endR, declared.s.r), c: Math.max(endC, declared.s.c) } });
  }
}

/** Excel (xlsx/xls/xlsm) -> array of row objects, one per sheet row, tagged with sheet name */
export function extractExcelRows(buffer) {
  const declared = declaredUncompressedBytes(buffer);
  if (declared !== null && declared > EXCEL_MAX_UNCOMPRESSED_BYTES) {
    const mb = Math.round(declared / 1048576);
    logger.warn(`Excel file rejected: expands to ${mb} MB (limit ${Math.round(EXCEL_MAX_UNCOMPRESSED_BYTES / 1048576)} MB)`);
    throw new Error(`Excel file is too large when decompressed (${mb} MB)`);
  }
  let workbook;
  try {
    // sheetRows stops SheetJS from even loading rows past the cap
    workbook = XLSX.read(buffer, { type: 'buffer', sheetRows: EXCEL_MAX_ROWS + 1 });
  } catch (err) {
    if (isPasswordRelated(err)) throw new PasswordProtectedError();
    logger.error('Failed to parse Excel file', { error: err.message });
    throw err;
  }
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    trimSheetRange(sheet, sheetName);
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const headerIdx = findHeaderRowIndex(aoa);

    // Bank narration sitting in the rows ABOVE the header
    let preambleNarration = '';
    if (headerIdx > 0) {
      for (const r of aoa.slice(0, headerIdx)) {
        const hit = (r || []).find((c) => typeof c === 'string' && looksLikeNarration(c));
        if (hit) {
          preambleNarration = hit.replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }

    const norm = (v) => String(v).replace(/\s+/g, ' ').trim();

    // Fallback: first narration-looking cell anywhere in the sheet
    let sheetNarration = preambleNarration;
    if (!sheetNarration) {
      for (let i = 0; i < aoa.length && !sheetNarration; i++) {
        if (i === headerIdx) continue;
        const hit = (aoa[i] || []).find((c) => typeof c === 'string' && looksLikeNarration(c));
        if (hit) sheetNarration = norm(hit);
      }
    }

    const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: null, range: headerIdx });
    for (const r of sheetRows) {
      const row = { __sheet: sheetName, ...r };
      if (!row['UTR Details']) {
        // 1) same column under a slightly different header ("UTR Details ", "utr details")
        const utrKey = Object.keys(row).find((k) => String(k).trim().toLowerCase() === 'utr details' && row[k]);
        // 2) a narration-looking value in this row's own cells (e.g. a "Narration"/"Remarks" column)
        const own = Object.entries(row).find(
          ([k, v]) => k !== '__sheet' && typeof v === 'string' && looksLikeNarration(v)
        );
        const value = utrKey ? norm(row[utrKey]) : own ? norm(own[1]) : sheetNarration;
        if (value) row['UTR Details'] = value;
      }
      rows.push(row);
    }
  }
  return rows;
}

// pdf.js is CPU/memory heavy
const MAX_PDF_PAGES = Math.max(1, Number(process.env.MAX_PDF_PAGES) || 100);
let pdfQueue = Promise.resolve();

export function extractPdfText(buffer, password) {
  const run = pdfQueue.then(() => extractPdfTextUnqueued(buffer, password));
  pdfQueue = run.catch(() => {}); // a failure must not block the queue
  return run;
}

const PDF_WORKER_PATH = fileURLToPath(new URL('./pdfWorker.js', import.meta.url));
const PDF_WORKER_MAX_MB = Math.max(128, Number(process.env.PDF_WORKER_MAX_MB) || 512);
const PDF_PARSE_TIMEOUT_MS = Math.max(5000, Number(process.env.PDF_PARSE_TIMEOUT_MS) || 60000);

/** PDF -> raw text via the embedded text layer (pdf.js) */
function extractPdfTextUnqueued(buffer, password) {
  return new Promise((resolve, reject) => {
    const child = fork(PDF_WORKER_PATH, [], {
      execArgv: [`--max-old-space-size=${PDF_WORKER_MAX_MB}`],
      serialization: 'advanced', // structured clone: Buffers/Uint8Arrays pass through
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      // The child parses untrusted PDFs from the internet
      env: { NODE_ENV: process.env.NODE_ENV || 'production' }
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (child.exitCode === null) child.kill('SIGKILL');
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`PDF parsing timed out after ${PDF_PARSE_TIMEOUT_MS / 1000}s (file skipped)`)),
      PDF_PARSE_TIMEOUT_MS
    );

    child.on('message', (msg) => {
      if (msg.ok) {
        if (msg.result.truncated) {
          logger.warn(`PDF has ${msg.result.numPages} pages — only the first ${MAX_PDF_PAGES} are read`);
        }
        return finish(resolve, msg.result);
      }
      if (msg.password) return finish(reject, new PasswordProtectedError());
      logger.error('Failed to parse PDF file', { error: msg.message });
      finish(reject, new Error(msg.message));
    });
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code, signal) =>
      finish(
        reject,
        new Error(
          `PDF parser process died (${signal || `exit code ${code}`}) — most likely out of memory on a malformed or very heavy PDF; file skipped`
        )
      )
    );

    try {
      child.send({ data: buffer, password, maxPages: MAX_PDF_PAGES }, (err) => {
        if (err) finish(reject, err);
      });
    } catch (err) {
      finish(reject, err); // e.g. IPC channel already closed — don't leak the child/timer
    }
  });
}
