import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = util.promisify(exec);

/**
 * ─── Extract Embedded JPEG Page Images from PDF Buffer ─────────────────────────
 * Fast 0ms buffer scanner to locate raw JPEG image streams in PDF documents.
 */
export function extractEmbeddedJpegs(pdfBuffer: Buffer, maxImages = 4): Buffer[] {
  const images: Buffer[] = [];
  let offset = 0;

  while (offset < pdfBuffer.length && images.length < maxImages) {
    const start = pdfBuffer.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]), offset);
    if (start === -1) break;

    const end = pdfBuffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 3);
    if (end === -1) break;

    const imgBuffer = pdfBuffer.subarray(start, end + 2);
    // Ignore tiny icons or inline graphics (< 8KB)
    if (imgBuffer.length > 8192) {
      images.push(imgBuffer);
    }
    offset = end + 2;
  }

  return images;
}

/**
 * ─── OCR Engine for Scanned / Image PDFs ──────────────────────────────────────
 * Multi-tier robust engine:
 * 1. ocrmypdf C++ CLI (if present on server)
 * 2. Embedded JPEG extraction + Vision AI (Gemini 2.5 Flash / Groq Vision — 1.2s extraction)
 * 3. Tesseract.js on page image buffers (with 8s strict timeout)
 */
export async function performPdfOcr(
  pdfBuffer: Buffer,
  maxPages = 4
): Promise<string> {
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const inputPdfPath = path.join(tempDir, `ocr_in_${timestamp}.pdf`);
  const outputPdfPath = path.join(tempDir, `ocr_out_${timestamp}.pdf`);

  let extractedText = '';

  // Tier 1: Try system native ocrmypdf CLI if installed (ultra-fast C++ Tesseract engine)
  try {
    fs.writeFileSync(inputPdfPath, pdfBuffer);
    await execAsync(`ocrmypdf --skip-text --max-pages ${maxPages} "${inputPdfPath}" "${outputPdfPath}"`, {
      timeout: 15000,
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

  // Tier 2: Extract embedded JPEG page images & use Vision AI (Gemini 2.5 Flash / Groq Vision)
  try {
    const pageImages = extractEmbeddedJpegs(pdfBuffer, maxPages);
    if (pageImages.length > 0) {
      console.log(`[OCR] Found ${pageImages.length} scanned page images in PDF. Processing with Vision AI...`);
      const { analyzeImage } = await import('../orchestrator/llm');
      const textParts: string[] = [];

      for (let i = 0; i < pageImages.length; i++) {
        const base64 = pageImages[i].toString('base64');
        const pageText = await analyzeImage(
          base64,
          'image/jpeg',
          'Extract all text, numbers, company details, dates, and financial tables from this scanned document page accurately.'
        );
        if (pageText && pageText.trim().length > 20) {
          textParts.push(`[Scanned Page ${i + 1} Content]:\n${pageText.trim()}`);
        }
      }

      if (textParts.length > 0) {
        extractedText = textParts.join('\n\n---\n\n');
        console.log(`[OCR] Vision AI extracted ${extractedText.length} chars from ${textParts.length} pages`);
        return extractedText;
      }
    }
  } catch (visionErr) {
    console.warn('[OCR] Vision AI page extraction failed:', (visionErr as Error).message);
  }

  // Tier 3: Tesseract.js on image buffers (with 8s strict timeout per page)
  try {
    const pageImages = extractEmbeddedJpegs(pdfBuffer, maxPages);
    if (pageImages.length > 0) {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      const pageTexts: string[] = [];

      for (const imgBuffer of pageImages) {
        const ocrPromise = worker.recognize(imgBuffer);
        const timeoutPromise = new Promise<{ data: { text: string } }>((resolve) =>
          setTimeout(() => resolve({ data: { text: '' } }), 8000)
        );
        const { data } = await Promise.race([ocrPromise, timeoutPromise]);
        if (data && data.text) {
          pageTexts.push(data.text);
        }
      }

      await worker.terminate();
      extractedText = pageTexts.join('\n\n');
      console.log(`[OCR] Tesseract.js extracted ${extractedText.length} chars`);
    }
  } catch (tessErr) {
    console.warn('[OCR] Tesseract.js fallback failed:', (tessErr as Error).message);
  }

  return extractedText;
}
