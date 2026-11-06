import Papa from 'papaparse';
import * as XLSX from 'xlsx';
// The "legacy" build is the Node-friendly entry point (no DOM/worker requirements) for pdfjs-dist
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Low-level, format-specific extractors */

export function classifyAttachment(filename, mimeType) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mt = (mimeType || '').toLowerCase();

  if (ext === 'csv' || mt === 'text/csv') return 'csv';
  if (['xlsx', 'xls', 'xlsm'].includes(ext) || mt.includes('spreadsheet') || mt === 'application/vnd.ms-excel') {
    return 'excel';
  }
  if (ext === 'pdf' || mt === 'application/pdf') return 'pdf';
  if (mt.startsWith('image/')) return 'image';
  return 'unsupported';
}

/** CSV -> array of row objects, headers inferred from the first line */
export function extractCsvRows(buffer) {
  const text = buffer.toString('utf-8');
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true
  });
  return result.data;
}

/** Excel (xlsx/xls/xlsm) -> array of row objects, one per sheet row, tagged with sheet name */
export function extractExcelRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    for (const r of sheetRows) rows.push({ __sheet: sheetName, ...r });
  }
  return rows;
}

/** PDF -> raw text via the embedded text layer (pdf.js) */
export async function extractPdfText(buffer) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    // Silence pdf.js font/cMap noise
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0
  }).promise;

  const pageTexts = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) pageTexts.push(`[Page ${pageNum}]\n${pageText}`);
    }
  } finally {
    await doc.cleanup();
  }

  const text = pageTexts.join('\n\n').trim();
  return {
    text,
    numPages: doc.numPages,
    hasTextLayer: text.length > 0
  };
}