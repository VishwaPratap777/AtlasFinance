import { Context } from 'telegraf';
import { chatStream, ChatMessage, selectOptimalModel } from '../../orchestrator/llm';
import { buildMessageHistory, persistMessages, getUserProfile, upsertUserProfile } from '../../orchestrator/conversation';
import { TOOL_DEFINITIONS, executeTool } from '../../orchestrator/tools';
import { buildRAGContext } from '../../rag/retriever';
import { Conversation } from '../../models/Conversation';
import { IUserProfile } from '../../models/UserProfile';

const MAX_TOOL_ROUNDS = 5; // prevent infinite tool-calling loops

// ─── Pre-LLM Guardrail: Block jailbreak / persona hijack attempts ──────────────
const JAILBREAK_PATTERNS = [
  /\b(pretend|imagine|act as|you are now|you're now|roleplay|role-play|role play)\b.*\b(girlfriend|boyfriend|lover|partner|therapist|doctor|lawyer|human|person|woman|man|girl|boy)\b/i,
  /\b(forget|ignore|disregard|override)\b.*\b(instructions?|system|rules?|prompts?|constraints?)\b/i,
  /\b(dan|jailbreak|developer mode|bypass|uncensored|no filter|no restriction)\b/i,
  /\b(flirt with me|kiss me|cuddle me|have sex|do sex|be my girlfriend|be my boyfriend|be my lover|marry me)\b/i,
  /new instructions?.*:/i,
  /you are no longer/i,
  /your (true|real|actual) (self|identity|persona|nature)/i,
];

const OFF_TOPIC_DEFLECTIONS = [
  "That's outside my lane — I'm Atlas, your financial analyst. What markets are you tracking today?",
  "Not my territory. I'm Atlas — stocks, crypto, earnings, macro. What can I pull up for you?",
  "I stay in my lane: markets, portfolios, and financial data. What do you want to look at?",
];

function isOffTopicRequest(text: string): string | null {
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(text)) {
      return OFF_TOPIC_DEFLECTIONS[Math.floor(Math.random() * OFF_TOPIC_DEFLECTIONS.length)];
    }
  }
  return null;
}

// ─── Escape Telegram markdown ──────────────────────────────────────────────────
function escapeMarkdown(text: string): string {
  // Only escape characters that break Telegram MarkdownV2 but keep our intentional formatting
  return text;
}

// ─── Format response for Telegram ─────────────────────────────────────────────
function formatForTelegram(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[a-zA-Z_0-9\-]+[^>]*>[\s\S]*?<\/[a-zA-Z_0-9\-]+>/gi, '')
    .replace(/<[a-zA-Z_0-9\-]+[^>]*>/gi, '')
    .replace(/<\/[a-zA-Z_0-9\-]+>/gi, '')
    .replace(/\{"(role|sectors|watchlist|portfolio|onboarding)"[\s\S]*?\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 4096);
}

// ─── Continuous Typing Indicator Manager ──────────────────────────────────────
export async function withContinuousTyping<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  await ctx.sendChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => {});
  }, 4000);

  try {
    return await action();
  } finally {
    clearInterval(interval);
  }
}

// ─── Core process message ─────────────────────────────────────────────────────
export async function processMessage(
  ctx: Context,
  userText: string,
  mediaType: 'text' | 'voice' | 'image' | 'document' = 'text'
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  return withContinuousTyping(ctx, async () => {
    try {
      // Check pre-LLM jailbreak / off-topic guardrail
      const deflection = isOffTopicRequest(userText);
      if (deflection) {
        await ctx.reply(deflection);
        return;
      }

      // Fetch profile and conversation context in parallel
      let [profile, conv] = await Promise.all([
        getUserProfile(telegramId),
        Conversation.findOne({ telegramId }),
      ]);

      // Ensure profile captures Telegram user details immediately (e.g. on first message or after /reset)
      if (ctx.from && (!profile || !profile.firstName)) {
        profile = await upsertUserProfile(telegramId, {
          firstName: ctx.from.first_name,
          username: ctx.from.username,
        });
      }

      // Build context
      let contextPrefix = '';

      // Add RAG context if user sent a document or has active documents & asks a relevant question (>3 words)
      const activeDocIds = conv?.activeDocumentIds || [];
      const wordCount = userText.trim().split(/\s+/).length;
      if (mediaType === 'document' || (activeDocIds.length > 0 && wordCount > 3)) {
        const ragContext = await buildRAGContext(telegramId, userText, activeDocIds.length > 0 ? activeDocIds : undefined);
        if (ragContext) {
          contextPrefix = ragContext + '\n\n---\n\nUser question: ';
        }
      }

      const augmentedUserText = contextPrefix + userText;
      let messages = await buildMessageHistory(telegramId, augmentedUserText, profile);

    // ─── Agentic tool-calling loop with Telegram Streaming ─────────────────
    let finalResponse = '';
    const allToolCalls: { name: string; args: Record<string, unknown>; result?: string }[] = [];
    let round = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let streamMessage: any = null;
    let lastEditTime = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      // Only pass tool definitions on round 1 to allow instant synthesis on round 2
      const activeTools = round === 1 ? TOOL_DEFINITIONS : undefined;

      // Dynamically route simple queries to fast 8B model and complex queries to 70B research model
      const preferredModel = selectOptimalModel(userText);

      const response = await chatStream(
        messages,
        activeTools,
        async (chunkText: string) => {
          const now = Date.now();
          if (now - lastEditTime > 1200 && chunkText.trim().length > 20) {
            lastEditTime = now;
            const formattedChunk = formatForTelegram(chunkText);
            try {
              if (!streamMessage) {
                streamMessage = await ctx.reply(formattedChunk, { parse_mode: 'Markdown' }).catch(() => null);
              } else {
                await ctx.telegram
                  .editMessageText(
                    ctx.chat?.id,
                    streamMessage.message_id,
                    undefined,
                    formattedChunk,
                    { parse_mode: 'Markdown' }
                  )
                  .catch(() => {});
              }
            } catch { /* ignore intermediate edit errors */ }
          }
        },
        preferredModel
      );

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No more tool calls — this is the final answer
        finalResponse = response.content;
        break;
      }

      // If tool calls were made, clear any intermediate streaming message so raw tool status text (e.g. "Update user profile:") is never displayed
      if (streamMessage && ctx.chat?.id) {
        await ctx.telegram.deleteMessage(ctx.chat.id, streamMessage.message_id).catch(() => {});
        streamMessage = null;
      }

      // Execute all tool calls in this round
      const toolResults: string[] = [];

      for (const tc of response.toolCalls) {
        await ctx.sendChatAction('typing');

        const result = await executeTool(
          tc.name,
          tc.args,
          profile,
          telegramId,
          async (updates: Partial<IUserProfile>) => {
            await upsertUserProfile(telegramId, updates);
          }
        );

        toolResults.push(`Tool: ${tc.name}\nResult: ${result}`);
        allToolCalls.push({ name: tc.name, args: tc.args, result });
      }

      // Add the assistant message with tool calls and tool results to history
      const assistantWithTools: ChatMessage = {
        role: 'assistant',
        content:
          response.content ||
          `I looked up: ${response.toolCalls.map((tc) => tc.name).join(', ')}`,
      };

      const toolResultMessage: ChatMessage = {
        role: 'user',
        content: `Tool results:\n${toolResults.join('\n\n')}\n\nNow synthesize these results into a concise, insightful response for the user. Remember: explain why it matters, don't just dump the data.`,
      };

      messages = [...messages, assistantWithTools, toolResultMessage];
    }

    if (!finalResponse) {
      finalResponse = "I wasn't able to get a clear response. Please try rephrasing your question.";
    }

    const formatted = formatForTelegram(finalResponse);

    // Send or finalize Telegram message
    if (streamMessage) {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          streamMessage.message_id,
          undefined,
          formatted,
          { parse_mode: 'Markdown' }
        );
      } catch {
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          streamMessage.message_id,
          undefined,
          formatted.replace(/[*_`]/g, '')
        ).catch(() => {});
      }
    } else {
      try {
        await ctx.reply(formatted, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ''));
      }
    }

    // Persist to DB
    await persistMessages(
      telegramId,
      userText,
      finalResponse,
      mediaType,
      allToolCalls.length > 0 ? allToolCalls : undefined
    );

    // Update last active
    if (ctx.from) {
      await upsertUserProfile(telegramId, {
        lastActiveAt: new Date(),
        firstName: ctx.from.first_name,
        username: ctx.from.username,
      } as Partial<IUserProfile>);
    }
    } catch (err) {
      console.error('[MessageHandler] Error:', err);
      await ctx.reply(
        "I hit an unexpected issue. Please try again in a moment — if the problem persists, check that all API keys are configured."
      );
    }
  });
}
