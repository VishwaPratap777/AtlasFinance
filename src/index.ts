import mongoose from 'mongoose';
import express from 'express';
import { env } from './config/env';
import { createBot, startBot } from './bot/index';

async function main(): Promise<void> {
  console.log('🌍 Atlas Financial Assistant starting...');

  // ── Connect to MongoDB ─────────────────────────────────────────────────────
  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
  }

  // ── Create and start Telegram bot ──────────────────────────────────────────
  const bot = createBot();

  if (env.NODE_ENV === 'production' && env.WEBHOOK_URL) {
    // Set up Express server for webhook
    const app = express();
    app.use(express.json());

    // Health check endpoint
    app.get('/health', (_, res) => {
      res.json({ status: 'ok', service: 'atlas', timestamp: new Date().toISOString() });
    });

    // Webhook endpoint
    const webhookPath = `/webhook/${env.WEBHOOK_SECRET}`;
    app.post(webhookPath, (req, res) => {
      bot.handleUpdate(req.body, res);
    });

    app.listen(env.PORT, () => {
      console.log(`✅ Express server listening on port ${env.PORT}`);
    });

    await startBot(bot);
  } else {
    // Development: long polling only
    await startBot(bot);
    console.log('✅ Atlas is running in development mode (long polling)');
    console.log('💬 Open Telegram and message your bot to get started');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
