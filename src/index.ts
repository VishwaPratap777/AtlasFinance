import mongoose from 'mongoose';
import express from 'express';
import { env } from './config/env';
import { createBot, startBot } from './bot/index';

async function main(): Promise<void> {
  console.log('🌍 Atlas Financial Assistant starting...');

  // ── Connect to MongoDB (with in-memory fallback) ───────────────────────────
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ MongoDB connected (Atlas Cloud)');
  } catch (err) {
    console.warn('⚠️ Remote MongoDB Atlas connection failed:', (err as Error).message);
    console.log('🔄 Starting local in-memory MongoDB fallback...');
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      const mongod = await MongoMemoryServer.create();
      const uri = mongod.getUri();
      await mongoose.connect(uri);
      console.log('✅ Connected to local in-memory MongoDB server!');
    } catch (memErr) {
      console.error('❌ Could not start database:', (memErr as Error).message);
      process.exit(1);
    }
  }

  // ── Create and start Telegram bot ──────────────────────────────────────────
  const bot = createBot();

  if (env.NODE_ENV === 'production' && env.WEBHOOK_URL) {
    const app = express();
    app.use(express.json());

    app.get('/health', (_, res) => {
      res.json({ status: 'ok', service: 'atlas', timestamp: new Date().toISOString() });
    });

    const webhookPath = `/webhook/${env.WEBHOOK_SECRET}`;
    app.post(webhookPath, (req, res) => {
      bot.handleUpdate(req.body, res);
    });

    app.listen(env.PORT, () => {
      console.log(`✅ Express server listening on port ${env.PORT}`);
    });

    await startBot(bot);
  } else {
    await startBot(bot);
    console.log('✅ Atlas is running in development mode (long polling)');
    console.log('💬 Open Telegram and message your bot to get started!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
