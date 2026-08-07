import { Conversation, IMessage } from '../models/Conversation';
import { UserProfile, IUserProfile } from '../models/UserProfile';
import { ChatMessage } from './llm';

const MAX_HISTORY = 12; // messages to send to LLM per turn (6 message pairs)
const MAX_STORED = 100; // messages to store in DB

// ─── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(profile: IUserProfile | null): string {
  const watchlistStr =
    profile?.watchlist?.length
      ? profile.watchlist.map((w) => w.ticker).join(', ')
      : 'none set yet';

  const portfolioStr =
    profile?.portfolio?.length
      ? profile.portfolio.map((h) => `${h.shares} ${h.ticker}`).join(', ')
      : 'none set yet';

  const roleStr = profile?.role || 'not specified';
  const now = new Date();
  const currentDateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const isoDateStr = now.toISOString().split('T')[0];

  const userNameStr = profile?.firstName ? profile.firstName : '';

  return `You are Atlas — a sharp, discreet financial analyst assistant living inside Telegram. Talk naturally like a senior sell-side analyst texting a trusted colleague.

## REAL-TIME DATE ANCHOR
- **Today's Date**: ${currentDateStr} (${isoDateStr}).
- Always ground all market queries relative to today (${isoDateStr}). NEVER cite 2024 or past training dates as current.

## PERSONALIZED GREETING & TONE
- Address user naturally ${userNameStr ? `by name ("Hey ${userNameStr}, ")` : ''} when starting a turn.
- Professional, human tone. Never use robotic boilerplate ("Here is your update" or "As an AI").

## EXPLAIN WHY FRAMEWORK (FOR MOVES & CATALYSTS)
When answering stock/market movements:
1. **What Happened**: Concise metric (e.g. **Tesla rose +4.2%**).
2. **Why**: Direct driver/catalyst (e.g. *Morgan Stanley upgraded to Overweight with a $310 PT*).
3. **Impact**: Key takeaway/sector impact (e.g. *Positive momentum across EV supply chain*).

## BEAUTIFUL MINIMAL MARKDOWN & CITATIONS
- Bold key financial figures (**$310.50**, **+4.2%**).
- Use compact inline citations where relevant (e.g. [SEC 10-K], [Finnhub]).
- If confidence is medium or based on estimates, add a subtle note: _Confidence: Medium (Market Estimates)_.

## MINIMAL FOLLOW-UP SUGGESTIONS
- **DO NOT OVERLOAD**: Offer 1 brief follow-up suggestion ONLY in ~20-30% of chats when genuinely useful (e.g. "_Want me to check competitor earnings?_"). Never add follow-up questions to every message.

## DYNAMIC DOCUMENT CONTRAST (FOR UPLOADED FILES & PDFs)
When analyzing user documents or filings, focus on:
1. **Core Highlights**: Key performance drivers and KPI numbers.
2. **Red Flags & Risks**: Litigations, debt shifts, or heightened risk factors.
3. **Anomalies**: Unexpected line item changes or discrepancies vs expectations.

## USER CONTEXT
- Name: ${userNameStr || 'Investor'}
- Role: ${roleStr}
- Watchlist tickers: ${watchlistStr}
- Portfolio: ${portfolioStr}
- Sectors of interest: ${profile?.sectors?.join(', ') || 'none specified'}
- Insight preferences: ${profile?.insightPreferences?.join(', ') || 'general finance'}

## STRICT REAL-TIME MARKET DATA MANDATE (NEVER HALLUCINATE PRICES)
- **NEVER** guess, estimate, fabricate, or cite stock or cryptocurrency prices, returns, or market stats from internal memory or training weights.
- **ALWAYS** invoke the appropriate tool ('get_stock_quote', 'get_company_profile', 'get_market_news', 'get_price_history', etc.) BEFORE answering any question about asset prices, stock/crypto quotes, or daily market movements.
- When the user asks "what about BTC?", "how is AAPL doing?", "Tesla price", or mentions any ticker/crypto token, you MUST call 'get_stock_quote' first.
- If a tool fails or provides no data, explicitly state that live market data could not be retrieved — NEVER state a fake or placeholder price.
- NEVER agree to a user's price correction without verifying via tool or explicitly stating the quote source.

## CAPABILITIES (VIA TOOLS)
Stock quotes, crypto prices, company profiles, earnings calendars, market news, SEC filings, price history, RAG document analysis. Use tools for live/verified data.

## ONBOARDING (NO FORMS, NO CONFIRMATION DIALOGS)
If onboarding is incomplete ('onboardingComplete: false'):
- **STRICTLY PROHIBITED**: Never say "Setting Up Your Profile", never present a "proposed setup", and never ask "Would you like to proceed or make adjustments?".
- **SILENT SAVING**: Execute tool 'update_user_profile' SILENTLY and reply with a brief 1-sentence response.
- Never output function names, XML tags, or JSON payloads in message text.

## CONVERSATION CONTINUITY
Maintain context across messages. Resolve pronouns (*its*, *their*, *this company*) against previous turns seamlessly.`;
}

// ─── Get or create conversation ────────────────────────────────────────────────
export async function getConversation(telegramId: number): Promise<import('../models/Conversation').IConversation> {
  let conv = await Conversation.findOne({ telegramId });
  if (!conv) {
    conv = new Conversation({ telegramId, messages: [] });
    await conv.save();
  }
  return conv;
}

import { getRedisHistory, setRedisHistory, ChatMessageCache } from '../config/redis';

// ─── Build LLM message array from history (Redis Hot Memory -> MongoDB Fallback) ──
export async function buildMessageHistory(
  telegramId: number,
  newUserMessage: string,
  profile: IUserProfile | null
): Promise<ChatMessage[]> {
  const systemPrompt = buildSystemPrompt(profile);
  const systemMessage: ChatMessage = { role: 'system', content: systemPrompt };

  let recentMessages: ChatMessage[] = [];

  // Try reading hot memory from Redis first (<1ms read)
  const cached = await getRedisHistory(telegramId);
  if (cached && cached.length > 0) {
    recentMessages = cached.map(
      (m: ChatMessageCache): ChatMessage => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })
    );
    console.log(`[Conversation/Redis] ⚡ Hot memory HIT: ${recentMessages.length} messages for Telegram ID ${telegramId}`);
  } else {
    // Redis miss or disabled -> query MongoDB Atlas
    const conv = await getConversation(telegramId);
    recentMessages = conv.messages
      .filter((m: IMessage) => m.role !== 'system')
      .slice(-MAX_HISTORY)
      .map(
        (m: IMessage): ChatMessage => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })
      );
    console.log(`[Conversation/MongoDB] Loaded ${recentMessages.length} messages from DB for Telegram ID ${telegramId}`);

    // Warm up Redis cache
    if (recentMessages.length > 0) {
      await setRedisHistory(telegramId, recentMessages);
    }
  }

  const userMessage: ChatMessage = { role: 'user', content: newUserMessage };

  return [systemMessage, ...recentMessages, userMessage];
}

// ─── Persist a message pair to DB & Redis Hot Memory ──────────────────────────
export async function persistMessages(
  telegramId: number,
  userContent: string,
  assistantContent: string,
  mediaType: 'text' | 'voice' | 'image' | 'document' = 'text',
  toolCalls?: { name: string; args: Record<string, unknown>; result?: string }[]
): Promise<void> {
  const conv = await getConversation(telegramId);

  const now = new Date();

  const userMsg: IMessage = {
    role: 'user',
    content: userContent,
    timestamp: now,
    mediaType,
  };

  const assistantMsg: IMessage = {
    role: 'assistant',
    content: assistantContent,
    timestamp: now,
    mediaType: 'text',
    toolCalls,
  };

  conv.messages.push(userMsg, assistantMsg);
  conv.lastMessageAt = now;

  // Trim stored history
  if (conv.messages.length > MAX_STORED) {
    const systemMsgs = conv.messages.filter((m: IMessage) => m.role === 'system');
    const otherMsgs = conv.messages.filter((m: IMessage) => m.role !== 'system');
    conv.messages = [...systemMsgs, ...otherMsgs.slice(-MAX_STORED)];
  }

  conv.markModified('messages');
  await conv.save();

  // Update Redis Hot Memory
  const updatedRecent = conv.messages
    .filter((m: IMessage) => m.role !== 'system')
    .slice(-MAX_HISTORY)
    .map((m: IMessage) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
  await setRedisHistory(telegramId, updatedRecent);

  console.log(`[Conversation] Persisted message turn to MongoDB & Redis (Total in DB: ${conv.messages.length})`);
}

// ─── Update user profile from conversation insights ───────────────────────────
export async function upsertUserProfile(
  telegramId: number,
  updates: Partial<IUserProfile>
): Promise<IUserProfile> {
  const profile = await UserProfile.findOneAndUpdate(
    { telegramId },
    { $set: { ...updates, lastActiveAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
  return profile;
}

export async function getUserProfile(telegramId: number): Promise<IUserProfile | null> {
  return UserProfile.findOne({ telegramId });
}

// Re-export Conversation model for direct use
export { Conversation } from '../models/Conversation';
