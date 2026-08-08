import Redis from 'ioredis';
import { env } from './env';

export interface ChatMessageCache {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

let redis: Redis | null = null;

if (env.REDIS_URL) {
  try {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => (times > 3 ? null : 1000),
    });

    redis.on('connect', () => {
      console.log('✅ Redis Connected (Hot Conversation Memory active)');
    });

    redis.on('error', (err) => {
      console.warn('⚠️ Redis Connection Error:', err.message);
    });
  } catch (err) {
    console.warn('⚠️ Failed to initialize Redis client:', (err as Error).message);
    redis = null;
  }
} else {
  console.log('ℹ️ REDIS_URL not set — running with direct MongoDB conversation memory');
}

export { redis };

const KEY_PREFIX = 'atlas:chat:';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days TTL for hot memory

// ─── Get Hot Conversation History from Redis (<1ms read) ──────────────────────
export async function getRedisHistory(telegramId: number): Promise<ChatMessageCache[] | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(`${KEY_PREFIX}${telegramId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ChatMessageCache[];
  } catch {
    return null;
  }
}

// ─── Set Hot Conversation History in Redis ────────────────────────────────────
export async function setRedisHistory(
  telegramId: number,
  messages: ChatMessageCache[]
): Promise<void> {
  if (!redis) return;
  try {
    const key = `${KEY_PREFIX}${telegramId}`;
    await redis.set(key, JSON.stringify(messages), 'EX', TTL_SECONDS);
  } catch {
    /* ignore cache write error */
  }
}

// ─── Clear Hot Conversation History in Redis (for /reset) ──────────────────────
export async function clearRedisHistory(telegramId: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`${KEY_PREFIX}${telegramId}`);
  } catch {
    /* ignore */
  }
}

// ─── Flush All Redis Data (System Admin Clear) ────────────────────────────────
export async function flushAllRedisData(): Promise<void> {
  if (!redis) return;
  try {
    await redis.flushall();
    console.log('[Redis] Complete flushall executed successfully.');
  } catch (err) {
    console.warn('[Redis] Flushall error:', (err as Error).message);
  }
}


// ─── Generic 60-90s Response & API Quote Cache ──────────────────────────────
export async function getCache<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(`atlas:cache:${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCache<T>(key: string, data: T, ttlSeconds = 75): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`atlas:cache:${key}`, JSON.stringify(data), 'EX', ttlSeconds);
  } catch {
    /* ignore */
  }
}
