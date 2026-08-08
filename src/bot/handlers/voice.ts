import { Context } from 'telegraf';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { transcribeVoice } from '../../orchestrator/llm';
import { processMessage } from './message';
import { getUserProfile } from '../../orchestrator/conversation';

export async function handleVoice(ctx: Context): Promise<void> {
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

  const voice = (ctx.message as { voice?: { file_id: string; duration: number } })?.voice;
  if (!voice) return;

  await ctx.sendChatAction('typing');

  let tempFile: string | null = null;

  try {
    // Get file download URL from Telegram
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
    const fileUrl = fileLink.href;

    // Download the OGG audio file
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data as ArrayBuffer);

    // Save temp file
    tempFile = path.join(os.tmpdir(), `atlas_voice_${telegramId}_${Date.now()}.ogg`);
    fs.writeFileSync(tempFile, audioBuffer);

    // Transcribe with Groq Whisper
    await ctx.sendChatAction('typing');
    const transcription = await transcribeVoice(audioBuffer, 'voice.ogg');

    if (!transcription || transcription.trim().length === 0) {
      await ctx.reply("I couldn't make out what you said. Could you send that again or type it out?");
      return;
    }

    // Show what was transcribed for clear UX feedback
    await ctx.reply(`🎙️ _"${transcription.trim()}"_`, { parse_mode: 'Markdown' }).catch(() => {});

    // Process as a regular message
    await processMessage(ctx, transcription, 'voice');
  } catch (err) {
    console.error('[VoiceHandler] Error:', err);
    await ctx.reply(
      "I had trouble processing your voice message. Please try again or type your question."
    );
  } finally {
    // Clean up temp file
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}
