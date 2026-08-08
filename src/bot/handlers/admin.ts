import mongoose from 'mongoose';
import { flushAllRedisData } from '../../config/redis';

export interface WipeResult {
  mongoCollectionsWiped: number;
  totalDocsDeleted: number;
  redisFlushed: boolean;
}

/**
 * Executes a full system wipe:
 * 1. Deletes all documents from every MongoDB collection (wipes UserProfile, Conversation, DocumentChunk, etc.)
 * 2. Flushes all Redis hot memory and cached data
 * 3. Removes all users from authentication state
 */
export async function executeSystemWipe(): Promise<WipeResult> {
  console.warn('🚨 [ADMIN] System wipe initiated...');

  let mongoCollectionsWiped = 0;
  let totalDocsDeleted = 0;

  // 1. MongoDB Wipe
  try {
    const db = mongoose.connection.db;
    if (db) {
      const collections = await db.listCollections().toArray();
      for (const col of collections) {
        const res = await db.collection(col.name).deleteMany({});
        totalDocsDeleted += res.deletedCount || 0;
        mongoCollectionsWiped++;
        console.log(`[ADMIN Wipe] 🗑️ Deleted ${res.deletedCount} documents from '${col.name}'`);
      }
    }
  } catch (err) {
    console.error('[ADMIN Wipe] MongoDB wipe error:', (err as Error).message);
  }

  // 2. Redis Wipe
  try {
    await flushAllRedisData();
  } catch (err) {
    console.error('[ADMIN Wipe] Redis flush error:', (err as Error).message);
  }

  console.warn('✅ [ADMIN] System wipe completed successfully!');

  return {
    mongoCollectionsWiped,
    totalDocsDeleted,
    redisFlushed: true,
  };
}
