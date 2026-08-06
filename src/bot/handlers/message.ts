import { Context } from 'telegraf';
import { chat, ChatMessage } from '../../orchestrator/llm';
import { buildMessageHistory, persistMessages, getUserProfile, upsertUserProfile } from '../../orchestrator/conversation';
import { TOOL_DEFINITIONS, executeTool } from '../../orchestrator/tools';
import { buildRAGContext } from '../../rag/retriever';
import { Conversation } from '../../models/Conversation';
import { IUserProfile } from '../../models/UserProfile';

const MAX_TOOL_ROUNDS = 5; // prevent infinite tool-calling loops

// ─── Escape Telegram markdown ──────────────────────────────────────────────────
function escapeMarkdown(text: string): string {
  // Only escape characters that break Telegram MarkdownV2 but keep our intentional formatting
  return text;
}

// ─── Format response for Telegram ─────────────────────────────────────────────
function formatForTelegram(text: string): string {
  // Trim excessive whitespace
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 4096); // Telegram message limit
}

// ─── Core process message ─────────────────────────────────────────────────────
export async function processMessage(
  ctx: Context,
  userText: string,
  mediaType: 'text' | 'voice' | 'image' | 'document' = 'text'
): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Show typing indicator
  await ctx.sendChatAction('typing');

  try {
    const profile = await getUserProfile(telegramId);

    // Build context
    let contextPrefix = '';

    // Add RAG context if user has documents and might be asking about them
    const conv = await Conversation.findOne({ telegramId });
    const activeDocIds = conv?.activeDocumentIds || [];
    if (activeDocIds.length > 0 || mediaType === 'document') {
      const ragContext = await buildRAGContext(telegramId, userText, activeDocIds.length > 0 ? activeDocIds : undefined);
      if (ragContext) {
        contextPrefix = ragContext + '\n\n---\n\nUser question: ';
      }
    }

    const augmentedUserText = contextPrefix + userText;
    let messages = await buildMessageHistory(telegramId, augmentedUserText, profile);

    // ─── Agentic tool-calling loop ─────────────────────────────────────────
    let finalResponse = '';
    const allToolCalls: { name: string; args: Record<string, unknown>; result?: string }[] = [];
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      const response = await chat(messages, TOOL_DEFINITIONS);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No more tool calls — this is the final answer
        finalResponse = response.content;
        break;
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

    // Send with Markdown parse mode
    try {
      await ctx.reply(formatted, { parse_mode: 'Markdown' });
    } catch {
      // Fallback to plain text if Markdown fails
      await ctx.reply(formatted.replace(/[*_`]/g, ''));
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
    await upsertUserProfile(telegramId, {
      lastActiveAt: new Date(),
      firstName: ctx.from.first_name,
      username: ctx.from.username,
    } as Partial<IUserProfile>);
  } catch (err) {
    console.error('[MessageHandler] Error:', err);
    await ctx.reply(
      "I hit an unexpected issue. Please try again in a moment — if the problem persists, check that all API keys are configured."
    );
  }
}
