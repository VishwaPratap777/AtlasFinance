import { Telegraf, Context } from 'telegraf';
import { env } from '../config/env';
import { processMessage } from './handlers/message';
import { handleVoice } from './handlers/voice';
import { handleDocument } from './handlers/document';
import { initScheduler } from '../scheduler/jobs';

export function createBot(): Telegraf {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // ─── Text messages ─────────────────────────────────────────────────────────
  bot.on('text', async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text) return;

    // Ignore messages from groups/channels — Atlas is private only
    if (ctx.chat.type !== 'private') {
      return;
    }

    await processMessage(ctx, text, 'text');
  });

  // ─── Voice messages ────────────────────────────────────────────────────────
  bot.on('voice', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await handleVoice(ctx as Context);
  });

  // ─── Photos (chart screenshots, etc.) ─────────────────────────────────────
  bot.on('photo', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await handleDocument(ctx as Context);
  });

  // ─── Document files (PDFs, etc.) ──────────────────────────────────────────
  bot.on('document', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await handleDocument(ctx as Context);
  });

  // ─── Audio (e.g. earnings call recordings) ─────────────────────────────────
  bot.on('audio', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    // Treat audio files like voice — transcribe and process
    const audio = ctx.message.audio;
    if (!audio) return;

    await ctx.reply("Processing audio file... this may take a moment.");

    // Reuse voice handler logic with audio file_id
    const fakeCtx = {
      ...ctx,
      message: { ...ctx.message, voice: { file_id: audio.file_id, duration: audio.duration } },
    };
    await handleVoice(fakeCtx as unknown as Context);
  });

  // ─── Error handling ────────────────────────────────────────────────────────
  bot.catch((err, ctx) => {
    console.error('[Bot] Unhandled error:', err);
    ctx.reply("Something went wrong on my end. Please try again.").catch(() => {});
  });

  return bot;
}

export async function startBot(bot: Telegraf): Promise<void> {
  if (env.NODE_ENV === 'production' && env.WEBHOOK_URL) {
    // Production: use webhook
    const webhookPath = `/webhook/${env.WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(`${env.WEBHOOK_URL}${webhookPath}`);
    console.log(`[Bot] Webhook set to ${env.WEBHOOK_URL}${webhookPath}`);
  } else {
    // Development: long polling
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('[Bot] Long polling started');
  }

  // Initialize background jobs
  initScheduler(bot);

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
