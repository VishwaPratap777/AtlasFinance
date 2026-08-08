import { Context } from 'telegraf';
import { chatStream, ChatMessage, selectOptimalModel, sanitizeLLMOutput } from '../../orchestrator/llm';
import { buildMessageHistory, persistMessages, getUserProfile, upsertUserProfile } from '../../orchestrator/conversation';
import { TOOL_DEFINITIONS, executeTool } from '../../orchestrator/tools';
import { detectQuoteIntent, extractQuoteTickers } from '../../tools/stockQuote';
import { buildRAGContext } from '../../rag/retriever';
import { Conversation } from '../../models/Conversation';
import { IUserProfile } from '../../models/UserProfile';

const MAX_TOOL_ROUNDS = 5; // prevent infinite tool-calling loops

// Write-only tools whose executor already returns a clean, user-ready confirmation
// string. When a round contains ONLY these, we can skip the synthesis LLM round and
// reply with the confirmation directly. update_user_profile is intentionally excluded:
// its "Profile updated." result is too bland, so it keeps flowing through synthesis to
// produce a natural reply (per the onboarding tone rules in the system prompt).
const SIDE_EFFECT_TOOLS = new Set<string>([
  'update_user_watchlist',
  'update_user_portfolio',
]);

// Tools that fetch real market/company data. Used by the anti-hallucination backstop:
// if the user asked for a live price but NONE of these ran, any price the model printed
// was fabricated from memory and must not be shown.
const DATA_TOOLS = new Set<string>([
  'get_stock_quote',
  'get_company_profile',
  'get_price_history',
  'get_analyst_ratings',
  'get_earnings_history',
  'get_earnings_calendar',
  'get_company_news',
  'get_market_news',
  'get_sec_filings',
  'search_sec_filings',
]);

// Detects a price/stat-card in model output: a $/₹ figure, or template fields
// (mcap, P/E, fwd P/E) that only appear when the model is quoting numbers.
const PRICE_OUTPUT_RE = /[$₹]\s?\d|(?:\bmcap\b|\bfwd\s*p\/e\b|\bp\/e\b|\bmarket\s*cap\b)/i;

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
  return sanitizeLLMOutput(text).substring(0, 4096);
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
    const tStart = Date.now();
    try {
      // Check pre-LLM jailbreak / off-topic guardrail
      const deflection = isOffTopicRequest(userText);
      if (deflection) {
        await ctx.reply(deflection);
        return;
      }

      // Fetch profile and conversation context in parallel.
      // Project only activeDocumentIds — loading the full messages array on every
      // turn is a large, needless read (chat history lives in Redis hot memory).
      let [profile, convDoc] = await Promise.all([
        getUserProfile(telegramId),
        Conversation.findOne({ telegramId }).select('activeDocumentIds').lean(),
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
      const activeDocIds = convDoc?.activeDocumentIds || [];
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

    // Route once per message: simple queries → fast 8B, deep-research → 70B.
    const routedModel = selectOptimalModel(userText);
    const DECISION_MODEL = 'llama-3.1-8b-instant';

    // If the user named an asset and wants a live read, we must never let the fast 8B
    // model answer a price from stale training memory. Two mechanisms:
    //  - quoteTickers: an unambiguous price ask on one or more named assets we can
    //    resolve ourselves → skip the decision LLM entirely and call get_stock_quote
    //    directly (faster, and immune to the model mis-picking a write-tool when a
    //    recent watchlist add primes it).
    //  - quoteIntent: fuzzier price language → keep the LLM path, backed by the
    //    Layer-2 anti-hallucination guard below.
    const quoteTickers = extractQuoteTickers(userText);
    const quoteIntent = detectQuoteIntent(userText);

    // Progressive Telegram streaming callback (used only for synthesis/answer rounds).
    const streamChunk = async (chunkText: string) => {
      const now = Date.now();
      if (now - lastEditTime > 800 && chunkText.trim().length > 40) {
        lastEditTime = now;
        const formattedChunk = formatForTelegram(chunkText);
        try {
          if (!streamMessage) {
            streamMessage = await ctx.reply(formattedChunk, { parse_mode: 'Markdown' }).catch(() => null);
          } else {
            await ctx.telegram
              .editMessageText(ctx.chat?.id, streamMessage.message_id, undefined, formattedChunk, { parse_mode: 'Markdown' })
              .catch(() => {});
          }
        } catch { /* ignore intermediate edit errors */ }
      }
    };

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      // Round 1 only: offer tools and let the fast 8B model decide which (if any) to call.
      // Later rounds synthesize tool output on the routed model (70B for deep research).
      const isDecisionRound = round === 1;
      const activeTools = isDecisionRound ? TOOL_DEFINITIONS : undefined;
      const modelForRound = isDecisionRound ? DECISION_MODEL : routedModel;

      // Stream only synthesis rounds — a decision round's partial text is discarded the
      // instant a tool call is chosen, so streaming it just burns Telegram edit calls.
      const onChunk = isDecisionRound ? undefined : streamChunk;

      // On a deep-research query the decision round runs on fast 8B purely to pick tools.
      // If it answers directly (no tool), we regenerate on 70B just below — so cap its
      // tokens to stop it spending time writing a full answer we're about to throw away.
      const roundMaxTokens =
        isDecisionRound && routedModel !== DECISION_MODEL ? 160 : undefined;

      let response;
      if (isDecisionRound && quoteTickers.length > 0) {
        // Deterministic quote fast-path: the turn is an unambiguous price ask on one or
        // more named assets, so we inject the get_stock_quote call(s) ourselves and skip
        // the decision LLM entirely. Removes a full round-trip AND guarantees the correct
        // tool — the primed 8B otherwise re-fires a recent write-tool (e.g. answering
        // "what about SOL and LTC?" with update_user_watchlist right after a watchlist add).
        response = {
          content: '',
          toolCalls: quoteTickers.map((ticker) => ({ name: 'get_stock_quote', args: { ticker } })),
          provider: 'fast-path',
        };
        console.log(`[MessageHandler/timing] round=${round} fast-path get_stock_quote [${quoteTickers.join(', ')}]`);
      } else {
        const tRound = Date.now();
        response = await chatStream(messages, activeTools, onChunk, modelForRound, roundMaxTokens);
        console.log(
          `[MessageHandler/timing] round=${round} model=${modelForRound} decision=${isDecisionRound} ${Date.now() - tRound}ms`
        );
      }

      // Only the DECISION round may trigger tools. Synthesis rounds are terminal: their
      // prose must never be re-interpreted as a tool call. The 8B model sometimes emits
      // function-like text (e.g. "get_stock_quote>{...}" or a bare {"ticker":"USO"}),
      // which extractFallbackToolCalls would mis-read as a real call — spawning phantom
      // extra LLM rounds (slow) AND orphaning the streamed partial as a truncated second
      // message (line ~196 deletes+nulls streamMessage, but the delete fails silently).
      if (!isDecisionRound) {
        response.toolCalls = undefined;
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // No tool calls — this is the answer.
        finalResponse = response.content;

        // Deep-research query the fast model answered directly: upgrade with one
        // streamed pass on the routed 70B model so quality isn't lost to the router.
        if (isDecisionRound && routedModel !== DECISION_MODEL) {
          const tUpgrade = Date.now();
          const upgraded = await chatStream(messages, undefined, streamChunk, routedModel).catch(() => null);
          console.log(`[MessageHandler/timing] upgrade model=${routedModel} ${Date.now() - tUpgrade}ms`);
          if (upgraded && upgraded.content) finalResponse = upgraded.content;
        }
        break;
      }

      // If tool calls were made, clear any intermediate streaming message so raw tool status text (e.g. "Update user profile:") is never displayed.
      // If delete fails, KEEP streamMessage reference so final response edits it in-place instead of creating duplicate messages!
      if (streamMessage && ctx.chat?.id) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, streamMessage.message_id);
          streamMessage = null;
        } catch {
          console.warn('[MessageHandler] Could not delete intermediate stream message; keeping reference for in-place overwrite.');
        }
      }

      // Keep the typing indicator alive without blocking tool execution.
      ctx.sendChatAction('typing').catch(() => {});

      // Execute this round's tool calls in parallel — they're independent lookups.
      const tTools = Date.now();
      const settled = await Promise.all(
        response.toolCalls.map(async (tc) => {
          const result = await executeTool(
            tc.name,
            tc.args,
            profile,
            telegramId,
            async (updates: Partial<IUserProfile>) => {
              await upsertUserProfile(telegramId, updates);
            }
          );
          return { tc, result };
        })
      );
      console.log(
        `[MessageHandler/timing] tools=[${response.toolCalls.map((t) => t.name).join(',')}] ${Date.now() - tTools}ms`
      );

      const toolResults: string[] = [];
      for (const { tc, result } of settled) {
        toolResults.push(`Tool: ${tc.name}\nResult: ${result}`);
        allToolCalls.push({ name: tc.name, args: tc.args, result });
      }

      // Side-effect-only round (watchlist/portfolio/briefing writes): the executor
      // already returns a user-ready confirmation, so reply with it directly and skip
      // the entire synthesis LLM round — one fewer full model call on these turns.
      if (response.toolCalls.every((tc) => SIDE_EFFECT_TOOLS.has(tc.name))) {
        finalResponse = settled.map((s) => s.result).join('\n');
        break;
      }

      // Add the assistant message with tool calls and tool results to history
      const sanitizedContent = sanitizeLLMOutput(response.content);
      const assistantWithTools: ChatMessage = {
        role: 'assistant',
        content:
          sanitizedContent ||
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

    // Anti-hallucination backstop: the user asked for a live price, the reply prints a
    // price/stat-card, yet no data tool actually ran → the number was invented from
    // memory. Never show it. This catches any asset the intent detector flagged but the
    // forced tool call still didn't cover (e.g. an unknown symbol Groq declined to look up).
    const usedDataTool = allToolCalls.some((tc) => DATA_TOOLS.has(tc.name));
    if (quoteIntent && !usedDataTool && PRICE_OUTPUT_RE.test(finalResponse)) {
      console.warn(
        `[MessageHandler] Blocked fabricated price (quoteIntent, no data tool ran). userText="${userText}"`
      );
      finalResponse =
        "I couldn't pull a live quote for that just now — my data feed didn't return in time. Give me the ticker again and I'll retry.";
    }

    const formatted = formatForTelegram(finalResponse);

    // Send or finalize Telegram message
    if (streamMessage) {
      let editSuccess = false;
      try {
        await ctx.telegram.editMessageText(
          ctx.chat?.id,
          streamMessage.message_id,
          undefined,
          formatted,
          { parse_mode: 'Markdown' }
        );
        editSuccess = true;
      } catch {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat?.id,
            streamMessage.message_id,
            undefined,
            formatted.replace(/[*_`]/g, '')
          );
          editSuccess = true;
        } catch {
          editSuccess = false;
        }
      }

      // If in-place edit failed completely, delete the orphan streamMessage before sending a new reply
      if (!editSuccess) {
        if (ctx.chat?.id) {
          await ctx.telegram.deleteMessage(ctx.chat.id, streamMessage.message_id).catch(() => {});
        }
        try {
          await ctx.reply(formatted, { parse_mode: 'Markdown' });
        } catch {
          await ctx.reply(formatted.replace(/[*_`]/g, ''));
        }
      }
    } else {
      try {
        await ctx.reply(formatted, { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ''));
      }
    }

    console.log(
      `[MessageHandler/timing] TOTAL ${Date.now() - tStart}ms rounds=${round} toolCalls=${allToolCalls.length}`
    );

    // Persist to DB
    await persistMessages(
      telegramId,
      userText,
      finalResponse,
      mediaType,
      allToolCalls.length > 0 ? allToolCalls : undefined
    );

    // Update last active — best-effort, non-blocking (reply is already sent).
    if (ctx.from) {
      void upsertUserProfile(telegramId, {
        lastActiveAt: new Date(),
        firstName: ctx.from.first_name,
        username: ctx.from.username,
      } as Partial<IUserProfile>).catch(() => {});
    }
    } catch (err) {
      console.error('[MessageHandler] Error:', err);
      await ctx.reply(
        "I hit an unexpected issue. Please try again in a moment — if the problem persists, check that all API keys are configured."
      );
    }
  });
}
