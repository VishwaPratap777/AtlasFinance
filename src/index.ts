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

  // ── Graceful Shutdown Handler ──────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    try {
      bot.stop(signal);
      await mongoose.connection.close();
      console.log('✅ Database connection closed cleanly.');
    } catch (err) {
      console.error('Error during shutdown:', (err as Error).message);
    }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // ── Start Express HTTP Server (Render Health Checks & Webhooks) ─────────────
  const app = express();
  app.use(express.json());

  app.get('/', (_, res) => {
    res.json({ status: 'ok', service: 'atlas', uptime: process.uptime() });
  });

  app.get('/health', (_, res) => {
    res.json({ status: 'ok', service: 'atlas', timestamp: new Date().toISOString() });
  });

  if (env.NODE_ENV === 'production' && env.WEBHOOK_URL) {
    const webhookPath = `/webhook/${env.WEBHOOK_SECRET}`;
    app.post(webhookPath, (req, res) => {
      bot.handleUpdate(req.body, res);
    });
  }

  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`✅ Express server listening on 0.0.0.0:${env.PORT} (Render Health Check Ready)`);
  });

  await startBot(bot);
  if (!(env.NODE_ENV === 'production' && env.WEBHOOK_URL)) {
    console.log('✅ Atlas is running in development/long-polling mode');
    console.log('💬 Open Telegram and message your bot to get started!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
