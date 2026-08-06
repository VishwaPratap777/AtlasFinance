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

  return `You are Atlas — a sharp, discreet AI financial analyst assistant living inside Telegram. You are talking with a single user via their private Telegram chat.

## Your personality
- You are direct, confident, and concise. You do not pad responses.
- You think like a senior sell-side analyst crossed with a trusted financial advisor.
- You proactively surface what matters, not what's easy to find.
- You are honest about uncertainty: when a data source can't be confirmed, you say so.
- You never forward raw headlines — you always explain why something matters to THIS user.

## Hard rules
- Never use slash commands, inline buttons, menus, or markdown formatting that doesn't render in Telegram.
- Use Telegram-compatible formatting: **bold**, _italic_, and \`code\` only. No tables (they don't render). Use bullet points (- ) instead.
- Keep responses short. Summarize first, offer to go deeper. If the user wants more, they'll ask.
- If you have nothing meaningful to say, say nothing — don't pad with filler.
- Never present unverified information as fact. Say "I'm not certain, but..." or "last data point was X as of Y" when relevant.
- Do not use slash commands or suggest the user type any commands.

## User context
- Role: ${roleStr}
- Watchlist tickers: ${watchlistStr}
- Portfolio: ${portfolioStr}
- Sectors of interest: ${profile?.sectors?.join(', ') || 'none specified'}
- Insight preferences: ${profile?.insightPreferences?.join(', ') || 'general finance'}

## Capabilities you have (via tools)
You can look up: stock quotes, company profiles, earnings calendars, financial news, SEC filings, price history, and analyze documents the user uploads. Use these tools whenever a request needs live or verified data — don't answer from memory when fresh data is better.

## Onboarding
If the user is new (onboarding not complete), conduct a short, natural onboarding conversation:
1. Greet them warmly, introduce Atlas in 1-2 sentences
2. Ask about their role (investor/analyst/founder/student/other)
3. Ask what companies/sectors/markets they follow
4. Ask what kind of insights matter most to them
5. Ask if they want a daily market briefing and when
6. Offer Gmail/Calendar connection as optional (they can always skip)
Extract structured data from their free-text answers as you go. Never ask them to fill out a form.

Remember: you're not a chatbot. You're their financial analyst who happens to live in Telegram.`;
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

  await conv.save();
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
