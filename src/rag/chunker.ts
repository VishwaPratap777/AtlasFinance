export interface Chunk {
  content: string;
  index: number;
  metadata?: Record<string, unknown>;
}

const CHUNK_SIZE = 800; // characters per chunk
const CHUNK_OVERLAP = 150;

export function chunkText(text: string, fileName: string, fileType: string): Chunk[] {
  // Clean the text
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{3,}/g, ' ')
    .trim();

  if (cleaned.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    let chunkEnd = end;

    // Try to break at a sentence boundary
    if (end < cleaned.length) {
      const periodIdx = cleaned.lastIndexOf('.', end);
      const newlineIdx = cleaned.lastIndexOf('\n', end);
      const breakIdx = Math.max(periodIdx, newlineIdx);
      if (breakIdx > start + CHUNK_SIZE / 2) {
        chunkEnd = breakIdx + 1;
      }
    }

    const content = cleaned.slice(start, chunkEnd).trim();
    if (content.length > 50) {
      chunks.push({
        content,
        index,
        metadata: { fileName, fileType, charStart: start, charEnd: chunkEnd },
      });
      index++;
    }

    start = Math.max(start + 1, chunkEnd - CHUNK_OVERLAP);
  }

  return chunks;
}

// Split a very long text (like a 10-K) with section awareness
export function chunkDocument(text: string, fileName: string, fileType: string): Chunk[] {
  // For very long documents, first split at major section headers
  const sectionPattern = /(?=\n(?:ITEM\s+\d+|PART\s+[IVX]+|SECTION\s+\d+|##\s+|###\s+))/gi;
  const sections = text.split(sectionPattern);

  if (sections.length <= 1 || text.length < CHUNK_SIZE * 3) {
    return chunkText(text, fileName, fileType);
  }

  const allChunks: Chunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    if (section.trim().length === 0) continue;
    const sectionChunks = chunkText(section, fileName, fileType);
    for (const chunk of sectionChunks) {
      allChunks.push({ ...chunk, index: globalIndex++ });
    }
  }

  return allChunks;
}
