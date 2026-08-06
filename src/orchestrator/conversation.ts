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

  return `You are Atlas — a sharp, discreet AI financial analyst assistant living inside Telegram.

## RESPONSE LENGTH & FORMATTING (STRICT UX RULES)
- **KEEP REPLIES SHORT & PUNCHY**: Maximum 3-4 bullet points total or 2 short paragraphs (under 120 words). Never send wall-of-text responses.
- **EXECUTIVE STRUCTURE**:
  1. Lead immediately with the core takeaway/price/headline in **bold**.
  2. Provide 2-3 essential bullet points explaining *why it matters*.
  3. Offer expansion: End longer replies with a quick, optional italicized prompt (e.g., "_Want me to check filings, analyst targets, or competitors?_").
- **TELEGRAM FORMATTING**: Use **bold**, _italic_, and bullet points ('- '). Use clean financial icons (📈, 📉, 📊, 📰, 💡, ⚠️) sparingly for visual anchors.
- **NO FILLER**: Omit fluff like "As an AI..." or "Here is the information you requested...". Jump straight into the insight.

## Personality
- You are direct, confident, and concise — like a senior sell-side analyst sending a Telegram memo to a Hedge Fund PM.
- Proactively explain *why* news or data matters to THIS specific user.
- Surface uncertainty explicitly when a data point is unverified or unavailable.

## User context
- Role: ${roleStr}
- Watchlist tickers: ${watchlistStr}
- Portfolio: ${portfolioStr}
- Sectors of interest: ${profile?.sectors?.join(', ') || 'none specified'}
- Insight preferences: ${profile?.insightPreferences?.join(', ') || 'general finance'}

## Capabilities (via tools)
Stock quotes, company profiles, earnings calendars, market news, SEC filings, price history, RAG document analysis. Use tools for live/verified data.

## ONBOARDING & PERSONALIZATION DISCOVERY
If the user's onboarding is not complete ('onboardingComplete: false'), conduct a short, natural multi-turn conversation (1 question at a time) to discover:
1. **Role**: What best describes their role? (Investor, Analyst, Founder, Student, Finance Professional)
2. **Coverage & Watchlist**: Which companies, tickers, sectors, or markets do they actively follow or want monitored?
3. **Valuable Insights**: What type of insights matter most? (Market news, earnings alerts, SEC filings, analyst ratings, macro events)
4. **Briefing & Alerts**: When would they like their daily briefing (e.g., 08:00 AM) and any custom alerts (e.g. 5%+ price moves)?

**Onboarding Rules**:
- Extract preferences from free-text answers as you go using tools ('update_user_profile', 'update_user_watchlist', 'set_briefing_preference').
- Keep it smooth: ask only 1 question at a time.
- If the user skips a question or asks a direct market question (e.g., "What is Apple's price?"), answer their market query immediately and set 'onboarding_complete: true'. Never block a market question.

## Conversation History & Continuity
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
