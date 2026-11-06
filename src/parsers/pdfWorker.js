// Runs in a short-lived CHILD PROCESS (forked by fileParsers.extractPdfText)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Rebuilds a page's visible line/column layout from pdf.js text items */
function reconstructPageText(items) {
  const Y_TOLERANCE = 2; // PDF points; fragments within this band = same line
  const frags = [];
  for (const item of items) {
    if (!('str' in item) || !item.str) continue;
    const [, , , , x, y] = item.transform ?? [1, 0, 0, 1, 0, 0];
    frags.push({ x, y, str: item.str });
  }
  frags.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const f of frags) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - f.y) <= Y_TOLERANCE) last.fragments.push({ x: f.x, str: f.str });
    else lines.push({ y: f.y, fragments: [{ x: f.x, str: f.str }] });
  }
  return lines
    .map((line) =>
      line.fragments
        .sort((a, b) => a.x - b.x)
        .map((f) => f.str)
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n');
}

async function extract({ data, password, maxPages }) {
  // Zero-copy view over the received bytes
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS, // silence cMap / "TT: undefined function" noise
    isEvalSupported: false,
    disableAutoFetch: true,
    ...(password ? { password } : {})
  });

  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const pageTexts = [];
  const pagesToRead = Math.min(numPages, maxPages);
  for (let n = 1; n <= pagesToRead; n++) {
    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      const text = reconstructPageText(content.items);
      if (text) pageTexts.push(`[Page ${n}]\n${text}`);
    } finally {
      page.cleanup();
    }
  }
  const text = pageTexts.join('\n\n').trim();
  return { text, numPages, hasTextLayer: text.length > 0, truncated: numPages > pagesToRead };
}

process.on('message', async (msg) => {
  let reply;
  try {
    reply = { ok: true, result: await extract(msg) };
  } catch (err) {
    const pwd = err?.name === 'PasswordException' || /password|encrypted/i.test(String(err?.message ?? ''));
    reply = { ok: false, password: pwd, message: String(err?.message ?? err) };
  }
  process.send(reply, () => process.exit(0));
});
