import { v4 as uuidv4 } from 'uuid';
import { DocumentChunk } from '../models/DocumentChunk';
import { chunkDocument } from './chunker';
import { embed, embedQuery, cosineSimilarity } from './embedder';

// ─── Ingest a document ────────────────────────────────────────────────────────
export async function ingestDocument(
  telegramId: number,
  text: string,
  fileName: string,
  fileType: string
): Promise<{ documentId: string; chunkCount: number }> {
  const documentId = uuidv4();
  const chunks = chunkDocument(text, fileName, fileType);

  if (chunks.length === 0) {
    throw new Error('Document is empty or could not be parsed.');
  }

  const texts = chunks.map((c) => c.content);
  const embeddings = await embed(texts);

  const docs = chunks.map((chunk, i) => ({
    telegramId,
    documentId,
    fileName,
    chunkIndex: chunk.index,
    content: chunk.content,
    embedding: embeddings[i],
    metadata: {
      source: fileName,
      uploadedAt: new Date(),
      fileType,
      totalChunks: chunks.length,
    },
  }));

  await DocumentChunk.insertMany(docs);

  return { documentId, chunkCount: chunks.length };
}

// ─── Query documents ──────────────────────────────────────────────────────────
export async function retrieveRelevantChunks(
  telegramId: number,
  query: string,
  documentIds?: string[],
  topK = 5
): Promise<{ content: string; score: number; fileName: string; chunkIndex: number }[]> {
  // Fetch candidate chunks for this user first
  const filter: { telegramId: number; documentId?: { $in: string[] } } = { telegramId };
  if (documentIds && documentIds.length > 0) {
    filter.documentId = { $in: documentIds };
  }

  // Fetch candidate chunks
  const candidates = await DocumentChunk.find(filter).limit(200).lean();
  if (candidates.length === 0) return [];

  // Compute query embedding only if candidate chunks exist
  const queryEmbedding = await embedQuery(query);

  // Score by cosine similarity
  const scored = candidates.map((chunk) => ({
    content: chunk.content,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
    fileName: chunk.fileName,
    chunkIndex: chunk.chunkIndex,
  }));

  // Sort and return top-k
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─── Build RAG context string for LLM ────────────────────────────────────────
export async function buildRAGContext(
  telegramId: number,
  query: string,
  documentIds?: string[]
): Promise<string> {
  const chunks = await retrieveRelevantChunks(telegramId, query, documentIds);

  if (chunks.length === 0) return '';

  const contextParts = chunks.map((c, i) => `[Excerpt ${i + 1} from "${c.fileName}"]:\n${c.content}`);

  return (
    'The following excerpts are from documents the user has uploaded. Use them to answer the question:\n\n' +
    contextParts.join('\n\n---\n\n')
  );
}

// ─── Delete a user's documents ────────────────────────────────────────────────
export async function deleteUserDocuments(telegramId: number, documentId?: string): Promise<void> {
  const filter: { telegramId: number; documentId?: string } = { telegramId };
  if (documentId) filter.documentId = documentId;
  await DocumentChunk.deleteMany(filter);
}

// ─── List user's documents ────────────────────────────────────────────────────
export async function listUserDocuments(telegramId: number): Promise<{ documentId: string; fileName: string; chunkCount: number; uploadedAt: Date }[]> {
  const docs = await DocumentChunk.aggregate([
    { $match: { telegramId } },
    {
      $group: {
        _id: '$documentId',
        fileName: { $first: '$fileName' },
        chunkCount: { $sum: 1 },
        uploadedAt: { $first: '$metadata.uploadedAt' },
      },
    },
    { $sort: { uploadedAt: -1 } },
  ]);

  return docs.map((d) => ({
    documentId: d._id as string,
    fileName: d.fileName as string,
    chunkCount: d.chunkCount as number,
    uploadedAt: d.uploadedAt as Date,
  }));
}
