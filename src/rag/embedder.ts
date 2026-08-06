import axios from 'axios';
import { env } from '../config/env';

const JINA_API = 'https://api.jina.ai/v1/embeddings';
const EMBEDDING_DIM = 768; // Jina v3 embedding dimension

let localPipeline: ((texts: string[]) => Promise<{ data: number[][] }>) | null = null;

// ─── Jina AI embeddings (primary) ─────────────────────────────────────────────
async function embedWithJina(texts: string[]): Promise<number[][]> {
  const { data } = await axios.post(
    JINA_API,
    {
      input: texts,
      model: 'jina-embeddings-v3',
      task: 'retrieval.passage',
    },
    {
      headers: {
        Authorization: `Bearer ${env.JINA_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

// ─── Local embeddings fallback (@xenova/transformers) ─────────────────────────
async function embedWithLocal(texts: string[]): Promise<number[][]> {
  if (!localPipeline) {
    const { pipeline } = await import('@xenova/transformers');
    const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    localPipeline = async (inputTexts: string[]) => {
      const results = await Promise.all(
        inputTexts.map((text) =>
          pipe(text, { pooling: 'mean', normalize: true })
        )
      );
      return {
        data: results.map((r) => Array.from((r as { data: Float32Array }).data) as number[]),
      };
    };
  }

  return (await localPipeline(texts)).data;
}

// ─── Public embed function with fallback ──────────────────────────────────────
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];

  // Batch in groups of 20 to avoid API limits
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 20) {
    batches.push(texts.slice(i, i + 20));
  }

  const allEmbeddings: number[][] = [];

  for (const batch of batches) {
    try {
      if (env.JINA_API_KEY) {
        const embeddings = await embedWithJina(batch);
        allEmbeddings.push(...embeddings);
      } else {
        throw new Error('No Jina key');
      }
    } catch {
      console.warn('[Embedder] Jina failed, using local model');
      const embeddings = await embedWithLocal(batch);
      allEmbeddings.push(...embeddings);
    }
  }

  return allEmbeddings;
}

export async function embedQuery(query: string): Promise<number[]> {
  if (env.JINA_API_KEY) {
    try {
      const { data } = await axios.post(
        JINA_API,
        { input: [query], model: 'jina-embeddings-v3', task: 'retrieval.query' },
        {
          headers: {
            Authorization: `Bearer ${env.JINA_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return data.data[0].embedding;
    } catch {
      // fall through
    }
  }
  const result = await embedWithLocal([query]);
  return result[0];
}

// ─── Cosine similarity ────────────────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}
