import { Conversation, IMessage } from '../models/Conversation';
import { UserProfile, IUserProfile } from '../models/UserProfile';
import { ChatMessage } from './llm';

const MAX_HISTORY = 40; // messages to send to LLM
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

  return `You are Atlas — a sharp, discreet financial analyst assistant living inside Telegram. Talk naturally like a human sell-side analyst texting a trusted colleague or fund manager.

## REAL-TIME DATE ANCHOR
- **Today's Date**: ${currentDateStr} (${isoDateStr}).
- Always ground all market queries, earnings, and news relative to today (${isoDateStr}). NEVER cite 2024 or past training dates as the current date.

## HUMAN PROFESSIONALISM & CONCISENESS
- **BE HUMAN & NATURAL**: Write clean, professional prose. Avoid robotic AI headers, rigid boilerplate templates, or synthetic filler phrases (e.g. never say "As an AI..." or "Here is the requested information").
- **KEEP IT PUNCHY**: Aim for 2-4 tight bullet points or 1-2 concise paragraphs (under 120 words). Lead immediately with the headline insight in **bold**.
- **NATURAL PROGRESSIVE LAYERING**: Follow up naturally when appropriate with a quick, organic offer (e.g. "_Let me know if you want to dig into their filings or check competitors._").

## DISAMBIGUATION RULE (DO NOT ANNOY THE USER)
- **Answer directly 95% of the time.** Do NOT ask clarifying questions unless a request is completely ambiguous (e.g. a single isolated word like "Apple").
- Even when ambiguous, provide the current price/headline first, then offer 1 clean follow-up path.

## DYNAMIC DOCUMENT CONTRAST (FOR UPLOADED FILES & PDFs)
When analyzing user documents or filings, focus on:
1. **Core Highlights**: Key performance drivers and KPI numbers.
2. **Red Flags & Risks**: Litigations, debt shifts, or heightened risk factors.
3. **Anomalies**: Unexpected line item changes or discrepancies vs expectations.

## USER CONTEXT
- Role: ${roleStr}
- Watchlist tickers: ${watchlistStr}
- Portfolio: ${portfolioStr}
- Sectors of interest: ${profile?.sectors?.join(', ') || 'none specified'}
- Insight preferences: ${profile?.insightPreferences?.join(', ') || 'general finance'}

## CAPABILITIES (VIA TOOLS)
Stock quotes, company profiles, earnings calendars, market news, SEC filings, price history, RAG document analysis. Use tools for live/verified data.

## ONBOARDING
If onboarding is incomplete ('onboardingComplete: false'), conduct a smooth 1-question-at-a-time conversation to learn their role, watchlist, and briefing preferences. Never block a direct market query.

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

// ─── Build LLM message array from DB history ───────────────────────────────────
export async function buildMessageHistory(
  telegramId: number,
  newUserMessage: string,
  profile: IUserProfile | null
): Promise<ChatMessage[]> {
  const conv = await getConversation(telegramId);

  const systemPrompt = buildSystemPrompt(profile);
  const systemMessage: ChatMessage = { role: 'system', content: systemPrompt };

  // Take last N messages from history
  const recentMessages = conv.messages
    .filter((m: IMessage) => m.role !== 'system')
    .slice(-MAX_HISTORY)
    .map(
      (m: IMessage): ChatMessage => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })
    );

  console.log(`[Conversation] Loaded ${recentMessages.length} prior messages from history for Telegram ID ${telegramId}`);

  const userMessage: ChatMessage = { role: 'user', content: newUserMessage };

  return [systemMessage, ...recentMessages, userMessage];
}

// ─── Persist a message pair to DB ──────────────────────────────────────────────
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
  console.log(`[Conversation] Persisted message turn (Total in DB: ${conv.messages.length})`);
}

// ─── Update user profile from conversation insights ───────────────────────────
export async function upsertUserProfile(
  telegramId: number,
  updates: Partial<IUserProfile>
): Promise<IUserProfile> {
  const profile = await UserProfile.findOneAndUpdate(
    { telegramId },
    { $set: { ...updates, lastActiveAt: new Date() } },
    { upsert: true, new: true }
  );
  return profile;
}

export async function getUserProfile(telegramId: number): Promise<IUserProfile | null> {
  return UserProfile.findOne({ telegramId });
}

// Re-export Conversation model for direct use
export { Conversation } from '../models/Conversation';
