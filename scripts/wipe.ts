/**
 * One-off data wipe — DESTRUCTIVE AND IRREVERSIBLE.
 * Clears ALL users: conversations, profiles, document chunks, and Redis.
 *
 * Run manually:  npx ts-node scripts/wipe.ts
 * No code touches this automatically — you pull the trigger.
 */
import mongoose from 'mongoose';
import Redis from 'ioredis';
import axios from 'axios';
import { env } from '../src/config/env';

async function main(): Promise<void> {
  console.log('⚠️  Wiping ALL user data. This cannot be undone.');
  console.log(`   Mongo: ${env.MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}`);

  // --- MongoDB ---
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    const db = mongoose.connection.db!;
    const collections = await db.listCollections().toArray();
    for (const c of collections) {
      const res = await db.collection(c.name).deleteMany({});
      console.log(`   🗑️  ${c.name}: deleted ${res.deletedCount} docs`);
    }
    console.log('✅ MongoDB wiped');
  } catch (err) {
    console.warn('⚠️  MongoDB wipe failed:', (err as Error).message);
  } finally {
    await mongoose.disconnect();
  }

  // --- Redis ---
  if (env.REDIS_URL) {
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    try {
      await redis.connect();
      const res = await redis.flushall();
      console.log(`✅ Redis flushed: ${res}`);
      redis.disconnect();
    } catch (err) {
      console.warn('⚠️  Redis flush failed:', (err as Error).message);
    }
  } else {
    console.log('ℹ️  REDIS_URL not set — skipping Redis');
  }

  // --- Telegram: drop webhook + any queued pending updates so nothing stale
  //     replays when Atlas restarts (the "fresh redeploy" slate). ---
  try {
    const { data } = await axios.post(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteWebhook`,
      { drop_pending_updates: true }
    );
    console.log(`✅ Telegram webhook cleared + pending updates dropped (ok=${data.ok})`);
  } catch (err) {
    console.warn('⚠️  Telegram webhook clear failed:', (err as Error).message);
  }

  console.log('✅ Wipe complete. Restart Atlas for a clean slate.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
