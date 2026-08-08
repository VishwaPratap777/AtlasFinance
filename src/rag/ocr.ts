import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = util.promisify(exec);

/**
 * ─── OCR Engine for Scanned / Image PDFs & Documents ──────────────────────────
 * 100% Free & Self-Hosted.
 * - Standard text PDFs: OCR is SKIPPED (0ms added delay).
 * - Scanned / Photo PDFs: Runs local Tesseract OCR (ocrmypdf CLI if available,
 *   or self-hosted Tesseract.js WebAssembly engine).
 */
export async function performPdfOcr(
  pdfBuffer: Buffer,
  maxPages = 5
): Promise<string> {
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const inputPdfPath = path.join(tempDir, `ocr_in_${timestamp}.pdf`);
  const outputPdfPath = path.join(tempDir, `ocr_out_${timestamp}.pdf`);

  fs.writeFileSync(inputPdfPath, pdfBuffer);

  let extractedText = '';

  // Tier 1: Try system native ocrmypdf CLI if installed (ultra-fast C++ Tesseract engine)
  try {
    await execAsync(`ocrmypdf --skip-text --max-pages ${maxPages} "${inputPdfPath}" "${outputPdfPath}"`, {
      timeout: 30000,
    });
    if (fs.existsSync(outputPdfPath)) {
      const outBuffer = fs.readFileSync(outputPdfPath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pdfParse = require('pdf-parse');
      const pdfFunc = pdfParse.default ?? pdfParse;
      const parsed = await pdfFunc(outBuffer);
      extractedText = parsed?.text || '';
    }
  } catch {
    // ocrmypdf not installed or failed — fall through to Tier 2
  } finally {
    if (fs.existsSync(inputPdfPath)) fs.unlinkSync(inputPdfPath);
    if (fs.existsSync(outputPdfPath)) fs.unlinkSync(outputPdfPath);
  }

  if (extractedText && extractedText.trim().length >= 50) {
    console.log(`[OCR] ocrmypdf CLI extracted ${extractedText.length} chars`);
    return extractedText;
  }

  // Tier 2: Self-hosted Tesseract.js engine (100% Free, Zero Native C++ Compilation Dependencies)
  try {
    const { createWorker } = await import('tesseract.js');
    console.log('[OCR] Running local Tesseract.js OCR scanner on scanned PDF...');
    const worker = await createWorker('eng');

    // Tesseract.js worker recognizes PDF buffers directly
    const { data } = await worker.recognize(pdfBuffer);
    if (data && data.text) {
      extractedText = data.text;
      console.log(`[OCR] Tesseract.js extracted ${extractedText.length} chars from scanned PDF`);
    }

    await worker.terminate();
  } catch (err) {
    console.warn('[OCR] Local Tesseract.js OCR fallback failed:', (err as Error).message);
  }

  return extractedText;
}
