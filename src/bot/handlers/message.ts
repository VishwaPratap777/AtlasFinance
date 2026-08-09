import { Context } from 'telegraf';
import { chatStream, ChatMessage, selectOptimalModel, sanitizeLLMOutput } from '../../orchestrator/llm';
import { buildMessageHistory, persistMessages, getUserProfile, upsertUserProfile } from '../../orchestrator/conversation';
import { TOOL_DEFINITIONS, executeTool } from '../../orchestrator/tools';
import { detectQuoteIntent, extractQuoteTickers, KNOWN_CRYPTO } from '../../tools/stockQuote';
import { buildRAGContext } from '../../rag/retriever';
import { Conversation } from '../../models/Conversation';
import { IUserProfile } from '../../models/UserProfile';
import { env } from '../../config/env';
import { executeSystemWipe } from './admin';
import { getCache, setCache } from '../../config/redis';

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

// ─── Extract recent focus tickers from conversation history ─────────────────────
function extractContextFocusTickers(messages: ChatMessage[]): string[] {
  const tickers: string[] = [];
  const knownTickers = new Set([
    'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META',
    'BTC', 'ETH', 'SOL', 'AMD', 'PLTR', 'NFLX', 'COIN', 'MSTR',
  ]);

  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i].content || '';
    const matches = text.match(/\b[A-Z]{2,5}\b/g) || [];
    for (const m of matches) {
      if (knownTickers.has(m)) {
        if (!tickers.includes(m)) tickers.push(m);
      }
    }
    if (tickers.length >= 2) break;
  }
  return tickers;
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
  await ctx.sendChatAction('typing').catch(() => { });
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => { });
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

      // Fetch profile and active doc IDs in parallel (with Redis caching for activeDocIds)
      let activeDocIds = await getCache<string[]>(`activedocs:${telegramId}`);
      const profilePromise = getUserProfile(telegramId);
      const convDocPromise = activeDocIds === null
        ? Conversation.findOne({ telegramId }).select('activeDocumentIds').lean()
        : Promise.resolve(null);

      let [profile, convDoc] = await Promise.all([profilePromise, convDocPromise]);
      if (activeDocIds === null) {
        activeDocIds = convDoc?.activeDocumentIds || [];
        await setCache(`activedocs:${telegramId}`, activeDocIds, 300);
      }

      // Ensure profile captures Telegram user details immediately (e.g. on first message or after /reset)
      if (ctx.from && (!profile || !profile.firstName)) {
        profile = await upsertUserProfile(telegramId, {
          firstName: ctx.from.first_name,
          username: ctx.from.username,
        });
      }

      // Check admin system wipe trigger
      if (userText.trim() === env.ADMIN_PASSWORD) {
        const result = await executeSystemWipe();
        await ctx.reply(
          `🚨 *SYSTEM DATA WIPED & RESET*\n\n` +
            `✅ Deleted ${result.totalDocsDeleted} documents across ${result.mongoCollectionsWiped} MongoDB collections.\n` +
            `✅ Flushed all Redis conversation memory & cache.\n` +
            `🔒 *All users have been logged out / removed from authentication.*\n\n` +
            `To use Atlas again, enter the access password (\`Atlas@123\`).`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Check password authentication
      if (!profile || !profile.isAuthenticated) {
        if (userText.trim() === env.ACCESS_PASSWORD) {
          profile = await upsertUserProfile(telegramId, { isAuthenticated: true });
          const nameStr = ctx.from?.first_name ? `, ${ctx.from.first_name}` : '';
          await ctx.reply(
            `🔓 *Access Granted!*\n\n` +
              `Greetings${nameStr}! 📈\n\n` +
              `I'm *Atlas* — your 24/7 institutional AI financial analyst. I live right here in Telegram to deliver real-time market quotes, SEC filing breakdowns, earnings catalysts, and scanned PDF intelligence without slash commands or menus.\n\n` +
              `To tailor my research feed specifically to you:\n` +
              `• Which *stocks or crypto tokens* (e.g. $NVDA, $BTC, $TSLA) are on your radar?\n` +
              `• What is your primary focus (*investor, founder, trader, or analyst*)?\n\n` +
              `Drop your tickers or sectors anytime and I'll track them live for you. What are we analyzing today?`,
            { parse_mode: 'Markdown' }
          );
          return;
        } else {
          await ctx.reply(
            "🔒 *Authentication Required*\n\nWelcome to Atlas! Please enter the access password to unlock the assistant:",
            { parse_mode: 'Markdown' }
          );
          return;
        }
      }

      // Pre-extract quote tickers & intent before RAG to bypass unnecessary embeddings
      const quoteTickers = extractQuoteTickers(userText);
      const quoteIntent = detectQuoteIntent(userText);
      const isQuoteAsk = quoteTickers.length > 0 || quoteIntent;

      // Build context
      let contextPrefix = '';

      // Add RAG context if user sent a document or has active documents & asks a non-quote question (>3 words)
      const wordCount = userText.trim().split(/\s+/).length;
      if (!isQuoteAsk && (mediaType === 'document' || (activeDocIds.length > 0 && wordCount > 3))) {
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
      // Automatic Focus Watchlist Auto-Tracker: Auto-add and promote user's focused tickers in their watchlist
      if (profile && quoteTickers.length > 0) {
        const currentWatchlist = profile.watchlist || [];
        const existingSet = new Set(currentWatchlist.map((w) => w.ticker));
        let watchlistUpdated = false;
        const newWatchlist = [...currentWatchlist];

        for (const ticker of quoteTickers) {
          if (!existingSet.has(ticker)) {
            newWatchlist.unshift({ ticker, alertThreshold: 5 });
            existingSet.add(ticker);
            watchlistUpdated = true;
          } else {
            const idx = newWatchlist.findIndex((w) => w.ticker === ticker);
            if (idx > 0) {
              const [item] = newWatchlist.splice(idx, 1);
              newWatchlist.unshift(item);
              watchlistUpdated = true;
            }
          }
        }

        if (watchlistUpdated) {
          upsertUserProfile(telegramId, { watchlist: newWatchlist }).catch(() => { });
        }
      }

      // Progressive Telegram streaming callback (used only for synthesis/answer rounds).
      let isEditing = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let streamMessagePromise: Promise<any> | null = null;

      const streamChunk = (chunkText: string) => {
        const now = Date.now();
        if (!isEditing && now - lastEditTime > 1200 && chunkText.trim().length > 80) {
          lastEditTime = now;
          isEditing = true;
          const formattedChunk = formatForTelegram(chunkText);
          streamMessagePromise = (async () => {
            try {
              if (!streamMessage) {
                streamMessage = await ctx.reply(formattedChunk, { parse_mode: 'Markdown' }).catch(() => null);
              } else if (streamMessage?.message_id) {
                await ctx.telegram
                  .editMessageText(ctx.chat?.id, streamMessage.message_id, undefined, formattedChunk, { parse_mode: 'Markdown' })
                  .catch(() => { });
              }
            } finally {
              isEditing = false;
            }
          })();
        }
      };

      // Extract context focus tickers for follow-ups (e.g. "what about volume?", "compare it to Tesla?")
      let resolvedTickers = [...quoteTickers];
      if (resolvedTickers.length === 0 && isQuoteAsk) {
        const contextTickers = extractContextFocusTickers(messages);
        if (contextTickers.length > 0) resolvedTickers = [contextTickers[0]];
      } else if (resolvedTickers.length === 1 && /\b(compare|versus|vs|difference|or)\b/i.test(userText)) {
        const contextTickers = extractContextFocusTickers(messages);
        for (const ct of contextTickers) {
          if (!resolvedTickers.includes(ct)) resolvedTickers.unshift(ct);
        }
      }

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
        if (isDecisionRound && resolvedTickers.length > 0) {
          const isCompareAsk = /\b(compare|versus|vs|difference|or)\b/i.test(userText);
          const isEarningsAsk = /\b(earnings|quarterly|eps|revenue|guidance|report|results|surprise|calendar)\b/i.test(userText);
          const isMoveAsk = /\b(why|cause|reason|dump\w*|pump\w*|fall\w*|ris\w*|crash\w*|spik\w*|mov\w*|drop\w*|gain\w*)\b/i.test(userText);
          const isPatternAsk = /\b(pattern\w*|trend\w*|technical|support|resistance|breakout\w*|consolidat\w*|momentum|30-?day|monthly|chart)\b/i.test(userText);

          // Simple price / snapshot query: short ask (<=4 words) or explicit price keywords without why/pattern/compare/news
          const wordCount = userText.trim().split(/\s+/).length;
          const isSimplePrice = !isCompareAsk && !isEarningsAsk && !isMoveAsk && !isPatternAsk &&
            (wordCount <= 4 || /\b(price|quote|worth|cost|value|level|\$[A-Z]+)\b/i.test(userText)) &&
            !/\b(how('s|\s+is)|what('s|\s+is)|news|update|why)\b/i.test(userText);

          const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

          for (const rawTicker of resolvedTickers) {
            const clean = rawTicker.toUpperCase().trim();
            const baseCrypto = clean.replace('-USD', '').replace(/USD$/, '');
            const isCrypto = KNOWN_CRYPTO.has(clean) || KNOWN_CRYPTO.has(baseCrypto);

            // 1. Primary quote is always needed for real-time market data
            toolCalls.push({ name: 'get_stock_quote', args: { ticker: clean } });

            // 2. Simple price query needs ONLY get_stock_quote (ultra-fast ~300ms response)
            if (isSimplePrice) {
              continue;
            }

            // 3. News context for move explanation, general updates ("how's BTC?"), news asks, or pattern queries
            toolCalls.push({ name: 'get_company_news', args: { ticker: clean, days: '3' } });

            // 4. Historical price data: fetch ONLY when pattern/trend/comparison explicitly requests historical context
            if (isPatternAsk || isCompareAsk) {
              toolCalls.push({ name: 'get_price_history', args: { ticker: clean, period: '1mo' } });

              if (isCompareAsk) {
                const peers = isCrypto
                  ? baseCrypto === 'BTC' ? ['ETH-USD'] : baseCrypto === 'ETH' ? ['BTC-USD'] : ['BTC-USD']
                  : ['SPY'];

                for (const peer of peers) {
                  toolCalls.push({ name: 'get_price_history', args: { ticker: peer, period: '1mo' } });
                }
                toolCalls.push({ name: 'get_company_profile', args: { ticker: clean, include_financials: 'true' } });
              }
            }

            if (isEarningsAsk) {
              toolCalls.push({ name: 'get_earnings_history', args: { ticker: clean } });
            }
          }

          response = {
            content: '',
            toolCalls,
            provider: 'fast-path',
          };
          console.log(`[MessageHandler/timing] round=${round} fast-path tools=[${toolCalls.map((t) => t.name).join(', ')}]`);
        } else {
          const tRound = Date.now();
          response = await chatStream(
            messages,
            activeTools,
            onChunk,
            modelForRound,
            roundMaxTokens,
            isDecisionRound && quoteIntent
          );
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

        // Keep streamMessage intact across rounds so final response edits in-place (prevents duplicate messages)
        ctx.sendChatAction('typing').catch(() => { });

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
                if (profile) Object.assign(profile, updates);
                void upsertUserProfile(telegramId, updates).catch(() => { });
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
          content: `Tool results:\n${toolResults.join('\n\n')}\n\nSynthesize into CONCISE analyst prose (3–6 sentences, NO section headers, NO filler):
FIND THE STRONGEST SIGNAL: A flat 24h move does NOT make everything uninterpretable. If 30d trend is strong, lead with it. If peer comparison shows divergence, state it. Always find the most informative timeframe.
NUMBERS: State key numbers (price, 24h %, 30d return, volume, peer comparisons) consolidated into flowing sentences.
INTERPRETATION: State what the numbers establish. Do NOT say "difficult to interpret" or "challenging to establish" when useful data exists.
NEWS: Include ONLY if directly about the asset AND explains the move or is material. Omit loosely related headlines silently.
SIGNED NUMBERS: +10.2% > +3.1% > -5.8%. NEVER say a positive-return asset "lags" a negative-return asset.
BANNED: "Monitor closely", "may be a precursor", "worth keeping an eye on", "investors may want to consider", "raises eyebrows". End after useful analysis.
TOOL ERRORS: NEVER mention tool names or API failures.`,
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
      const usedDataTool =
        allToolCalls.some((tc) => DATA_TOOLS.has(tc.name)) || quoteTickers.length > 0;

      if (quoteIntent && !usedDataTool && allToolCalls.length === 0 && PRICE_OUTPUT_RE.test(finalResponse)) {
        console.warn(
          `[MessageHandler] Blocked fabricated price (quoteIntent, no data tool ran). userText="${userText}"`
        );
        finalResponse =
          "I couldn't pull a live quote for that just now — my data feed didn't return in time. Give me the ticker again and I'll retry.";
      }

      const formatted = formatForTelegram(finalResponse);

      // Ensure any in-flight streaming message creation promise resolves before finalizing
      if (streamMessagePromise) {
        await (streamMessagePromise as Promise<unknown>).catch(() => { });
      }

      // Send or finalize Telegram message — ALWAYS overwrite streamMessage in-place if it exists
      if (streamMessage && streamMessage.message_id) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat?.id,
            streamMessage.message_id,
            undefined,
            formatted,
            { parse_mode: 'Markdown' }
          );
        } catch {
          // If Markdown parsing fails on tricky formatting, overwrite the existing message in-place with plain text!
          await ctx.telegram.editMessageText(
            ctx.chat?.id,
            streamMessage.message_id,
            undefined,
            formatted.replace(/[*_`]/g, '')
          ).catch(() => { });
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
        } as Partial<IUserProfile>).catch(() => { });
      }
    } catch (err) {
      console.error('[MessageHandler] Error:', err);
      await ctx.reply(
        "I hit an unexpected issue. Please try again in a moment — if the problem persists, check that all API keys are configured."
      );
    }
  });
}
