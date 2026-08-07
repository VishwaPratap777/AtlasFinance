import { Context } from 'telegraf';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { analyzeImage } from '../../orchestrator/llm';
import { processMessage } from './message';
import { ingestDocument } from '../../rag/retriever';
import { Conversation } from '../../models/Conversation';

// Supported document types
const SUPPORTED_DOCS = ['.pdf', '.txt', '.csv'];
const SUPPORTED_IMAGES = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

export async function handleDocument(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  await ctx.sendChatAction('typing');

  // Handle photos (screenshots of charts, etc.)
  const photo = (ctx.message as { photo?: { file_id: string; file_size?: number }[] })?.photo;
  if (photo) {
    await handlePhoto(ctx, photo[photo.length - 1]); // largest size
    return;
  }

  // Handle document files
  const doc = (ctx.message as {
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    caption?: string;
  })?.document;

  if (!doc) return;

  const caption = (ctx.message as { caption?: string })?.caption || '';
  const fileName = doc.file_name || 'document';
  const ext = path.extname(fileName).toLowerCase();

  // Check size (Telegram allows up to 20MB, but let's cap at 10MB for processing)
  if (doc.file_size && doc.file_size > 10 * 1024 * 1024) {
    await ctx.reply("That file is too large for me to process (max 10MB). Could you send a smaller excerpt?");
    return;
  }

  let tempFile: string | null = null;

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(response.data as ArrayBuffer);

    tempFile = path.join(os.tmpdir(), `atlas_doc_${telegramId}_${Date.now()}${ext}`);
    fs.writeFileSync(tempFile, fileBuffer);

    let extractedText = '';

    if (ext === '.pdf') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let pdfParse: any;
        try {
          const pdfParseModule = await import('pdf-parse');
          pdfParse = pdfParseModule.default ?? pdfParseModule;
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          pdfParse = require('pdf-parse');
        }

        if (typeof pdfParse === 'function') {
          const pdfData = await pdfParse(fileBuffer);
          extractedText = pdfData.text || '';
        } else if (pdfParse && typeof pdfParse.PDFParse === 'function') {
          const parser = new pdfParse.PDFParse();
          const pdfData = await parser.parseBuffer(fileBuffer);
          extractedText = pdfData.text || '';
        } else {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pdfReq = require('pdf-parse');
          const pdfFunc = pdfReq.default ?? pdfReq;
          const pdfData = await pdfFunc(fileBuffer);
          extractedText = pdfData.text || '';
        }
      } catch (pdfErr) {
        console.error('[DocumentHandler] PDF extraction error:', (pdfErr as Error).message);
        throw pdfErr;
      }
    } else if (ext === '.txt' || ext === '.csv') {
      extractedText = fileBuffer.toString('utf-8');
    } else if (SUPPORTED_IMAGES.includes(ext)) {
      // Treat as image
      const imageBase64 = fileBuffer.toString('base64');
      const mimeType = doc.mime_type || `image/${ext.slice(1)}`;
      const prompt = caption
        ? `The user sent this image with the caption: "${caption}". Please analyze it in the context of financial information, charts, or documents. ${caption}`
        : 'Please analyze this image. If it contains financial data, charts, tables, or document content, extract and explain the key information.';
      const analysis = await analyzeImage(imageBase64, mimeType, prompt);
      await processMessage(ctx, `[Image analysis]: ${analysis}`, 'image');
      return;
    } else {
      await ctx.reply(
        `I can read PDFs, text files, CSVs, and images. This file type (${ext}) isn't supported yet.`
      );
      return;
    }

    if (!extractedText || extractedText.trim().length < 50) {
      await ctx.reply("I couldn't extract text from that document. If it's a scanned PDF, try sending it as an image instead.");
      return;
    }

    await ctx.reply(`📄 Got it. Processing "${fileName}" (${Math.round(extractedText.length / 1000)}k chars)...`);

    // Ingest into RAG
    const { documentId, chunkCount } = await ingestDocument(
      telegramId,
      extractedText,
      fileName,
      ext.slice(1)
    );

    // Add to active document context for this conversation
    const conv = await Conversation.findOneAndUpdate(
      { telegramId },
      { $addToSet: { activeDocumentIds: documentId } },
      { upsert: true, returnDocument: 'after' }
    );
    void conv;

    // Dynamic Document Contrast prompt
    const userPrompt = caption
      ? caption
      : `I've uploaded "${fileName}". Provide a Dynamic Document Contrast analysis:
- **Core Highlights**: Key performance numbers & KPI drivers.
- **Red Flags & Risks**: Heightened risk factors, debt shifts, or margin pressures.
- **Anomalies**: Unexpected line item changes or discrepancies.
Keep it concise and professional.`;

    await processMessage(ctx, userPrompt, 'document');
  } catch (err) {
    console.error('[DocumentHandler] Error:', err);
    await ctx.reply("I had trouble processing that document. Please try again.");
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

async function handlePhoto(
  ctx: Context,
  photo: { file_id: string }
): Promise<void> {
  const caption = (ctx.message as { caption?: string })?.caption || '';

  try {
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data as ArrayBuffer);
    const imageBase64 = imageBuffer.toString('base64');

    const prompt = caption
      ? `The user sent this image with caption: "${caption}". Analyze it as a financial professional would. Extract numbers, trends, and key insights.`
      : 'Analyze this image. If it shows a chart, financial statement, or document, extract and explain the key financial information and what it means.';

    const analysis = await analyzeImage(imageBase64, 'image/jpeg', prompt);
    await processMessage(ctx, `[Image content]: ${analysis}${caption ? '\n\nUser note: ' + caption : ''}`, 'image');
  } catch (err) {
    console.error('[DocumentHandler] Photo error:', err);
    await ctx.reply("I couldn't analyze that image. Please try a clearer photo or describe what you're looking at.");
  }
}
