import { Telegraf, Context } from 'telegraf';
import { env } from '../config/env';
import { processMessage } from './handlers/message';
import { handleVoice } from './handlers/voice';
import { handleDocument } from './handlers/document';
import { initScheduler } from '../scheduler/jobs';

import { UserProfile } from '../models/UserProfile';
import { Conversation } from '../models/Conversation';
import { DocumentChunk } from '../models/DocumentChunk';

import { clearRedisHistory } from '../config/redis';
import { getUserProfile } from '../orchestrator/conversation';
import { executeSystemWipe } from './handlers/admin';

export function createBot(): Telegraf {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // ─── Admin Clear Command (Full System Wipe) ──────────────────────────────
  bot.command('clear', async (ctx) => {
    const text = ctx.message.text?.trim() || '';
    const parts = text.split(/\s+/);
    const passwordArg = parts[1];

    if (passwordArg === env.ADMIN_PASSWORD) {
      const result = await executeSystemWipe();
      await ctx.reply(
        `🚨 *SYSTEM DATA WIPED & RESET*\n\n` +
          `✅ Deleted ${result.totalDocsDeleted} documents across ${result.mongoCollectionsWiped} MongoDB collections.\n` +
          `✅ Flushed all Redis conversation memory & cache.\n` +
          `🔒 *All users have been logged out / removed from authentication.*\n\n` +
          `Enter password to start fresh!`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        "⚠️ *Admin Clear Command*\n\n" +
          "This command will permanently wipe all MongoDB data, flush Redis cache, and log out all users.\n\n" +
          "To proceed, please enter:\n`/clear <admin_password>`\nwith your admin password.",
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ─── Reset Command (testing helper) ────────────────────────────────────────
  bot.command('reset', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const profile = await getUserProfile(telegramId);
    if (!profile || !profile.isAuthenticated) {
      await ctx.reply(
        "🔒 *Authentication Required*\n\nPlease enter the access password to start using Atlas:",
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await UserProfile.deleteOne({ telegramId });
    await Conversation.deleteOne({ telegramId });
    await DocumentChunk.deleteMany({ telegramId });
    await clearRedisHistory(telegramId);

    await ctx.reply(
      "🔄 *Profile & History Reset*\n\nYour profile, watchlist, portfolio, and conversation history have been cleared to zero.\n\nEnter password to start fresh!",
      { parse_mode: 'Markdown' }
    );
  });

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
    try {
      await bot.telegram.deleteWebhook().catch(() => {});
      bot.launch().catch((err) => {
        const msg = (err as Error).message || '';
        if (msg.includes('409') || msg.includes('Conflict')) {
          console.warn('[Bot] ⚠️ Long polling conflict: another instance (e.g. Render production server) is currently active on this token.');
        } else {
          console.error('[Bot] Launch error:', msg);
        }
      });
      console.log('[Bot] Long polling active');
    } catch (err) {
      console.warn('[Bot] Start error:', (err as Error).message);
    }
  }

  // Initialize background jobs
  initScheduler(bot);

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
