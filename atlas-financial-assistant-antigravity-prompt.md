# ATLAS — AI Financial Assistant for Telegram
### Master Build Prompt for Antigravity

Paste this entire document into Antigravity as the project brief. It is written so an autonomous coding agent can plan, scaffold, and build the full product without further clarification. Where a decision was left open by the source assignment, a concrete default is specified so the agent doesn't stall — override any of these defaults freely.

---

## 0. What you are building

Build **Atlas**, an AI-powered financial assistant that lives entirely inside Telegram. It should feel like texting a sharp, discreet financial analyst who already knows your portfolio, your calendar, and your inbox — not like using a chatbot or a bot with commands.

**Guiding rule for every decision you make:** if a feature doesn't save the user time or surface something that actually matters, cut it. Depth and judgment beat feature count. This project is evaluated on usefulness, product judgment, conversational AI quality, finance depth, and engineering quality — in that order of weight (30/25/20/15/10).

**Hard constraints — do not violate these:**
- Telegram is the only interface.
- Users interact with **text, voice messages, and images only**.
- **No slash commands, no inline buttons, no menus, no quick replies, no command-based navigation.** Every interaction must be resolvable through natural language. If you catch yourself designing a `/start` command flow or a button-driven settings panel, stop and redesign it as a conversation.
- Responses must be **concise** — no long scrolling reports. Summarize to what matters; offer to go deeper rather than dumping everything.
- If there's nothing meaningful to report in a proactive update, **send nothing**. Silence is a valid (and preferred) output.
- Never present unverified financial information as fact — surface uncertainty explicitly when a source can't be confirmed.

---

## 1. Tech stack (build with this unless you find a materially better free option)

- **Backend:** Node.js + TypeScript, Express (or NestJS if you want stronger module boundaries) — matches proven prior work, keeps the codebase interview-defensible.
- **Telegram layer:** `telegraf` (cleanest TypeScript support, built-in scenes/session if needed, but do not use its button/keyboard features).
- **Database:** MongoDB (Atlas free tier) — flexible schema fits conversation history, evolving user preference objects, and document metadata well. Use Mongoose for schema discipline.
- **Background jobs / scheduling:** `node-cron` or `agenda` (Mongo-backed job queue) for daily briefings, earnings-call reminders, and watchlist polling.
- **Hosting:** Render / Railway / Fly.io free tier for the bot process + webhook endpoint; MongoDB Atlas free tier for the DB.

### AI / LLM layer — Groq-first, all free tier
You mentioned Groq — it's actually the right call here, not just the affordable one, because Telegram conversations need low-latency responses and Groq's inference speed is the best fit for a chat-first UX:

- **Primary reasoning model:** Groq-hosted `llama-3.3-70b-versatile` (or the current best Groq-hosted Llama/Qwen model at build time — check Groq's model list, it changes). Free tier, generous rate limits, fast enough that responses feel instant in Telegram.
- **Voice transcription:** Groq Whisper (`whisper-large-v3-turbo`) — since you're already on Groq, this keeps you on one provider for both text and voice, it's free tier, and it's dramatically faster than OpenAI Whisper. This directly satisfies the "voice messages" input requirement.
- **Image understanding** (screenshots of charts, photographed documents, receipts of trade confirmations): Groq now hosts vision-capable Llama models (`llama-4-scout`/`maverick` class) — use whichever current Groq vision model is available; fallback to Gemini 2.5 Flash's free tier (very capable, generous free quota, good OCR) if Groq's vision model isn't sufficient for document-heavy images.
- **Fallback chain:** Groq → Gemini 2.5 Flash (free tier) → keep a fallback so a single provider outage doesn't take the bot down. This mirrors a dual-provider pattern worth keeping for resilience.
- **Embeddings for document RAG:** free options only — Jina AI free embeddings API, or run `all-MiniLM-L6-v2` locally via `@xenova/transformers` (zero cost, no API dependency) for chunking and searching uploaded financial documents.
- **Tool-calling / function-calling:** use Groq's native tool-use support to let the model decide when to hit live data sources, when to search memory, and when to ask a clarifying question — don't hardcode intent-routing with regex/keywords, let the model route.

### Free financial data sources (pick 2–3, don't try to wire all of them — depth over breadth)
- **SEC EDGAR full-text search + filing API** — completely free, no key required. This is your strongest, most defensible source: real filings (10-K, 10-Q, 8-K, insider Form 4s). Use it for the filings and regulatory-announcement capabilities.
- **Finnhub free tier** — real-time-ish quotes, company fundamentals, earnings calendar, news, insider transactions. Best single free API for breadth.
- **Alpha Vantage free tier** — backup/secondary for price history and fundamental ratios if Finnhub's free rate limit is hit.
- **Yahoo Finance (via `yahoo-finance2` npm package)** — free, no key, good for quick price/summary lookups and as another fallback.
- Recommended combo: **SEC EDGAR (filings) + Finnhub (quotes/earnings/news) + Alpha Vantage (fallback)**. This gives real depth in the finance vertical without integration sprawl.

### Google integrations (productivity + financial workspace)
- **Gmail API** — read-only scope initially, for email summarization and pulling company context from threads.
- **Google Calendar API** — for meeting prep and reminders.
- **Google Drive + Sheets API** — for analyzing uploaded/linked spreadsheets and documents conversationally.
- All via OAuth2, offered conversationally during onboarding ("Want me to check your calendar for meetings I should prep you for? I can also skip this — just say so"), never as a forced step.

---

## 2. Onboarding (conversational, not a form)

Do not build a wizard. Build a short, natural conversation the model conducts, extracting structured preferences from free-text answers as it goes. The model should ask 3–5 of the following, adapt based on answers already given, and let the user skip anything or dive straight into a real question instead:

- Role (investor / analyst / founder / student / finance professional / other)
- Companies, sectors, or markets they follow
- Specific tickers or topics to monitor going forward
- What kind of insight is most valuable to them (market news, earnings, filings, analyst ratings, macro events)
- When they want their daily briefing, if at all
- Any custom alerts they want set up now (e.g., "tell me if Tesla moves more than 5% in a day")
- Optional: offer Gmail / Calendar / Drive / Sheets connection, explicitly skippable
- Optional: offer additional verticals beyond finance (startup ecosystem, tech, healthcare, etc.) — **finance stays the default and primary vertical regardless**

Store everything extracted into a structured `UserProfile` document, but keep collecting and refining it from every subsequent conversation — onboarding never really "ends."

---

## 3. Core capabilities to implement

### 3.1 Daily / proactive intelligence
- Morning market brief, evening summary, watchlist-specific updates, earnings alerts, filing alerts — scheduled per the user's stated preference.
- Every proactive message must explain **why it matters**, not just restate a headline. ("Nvidia is down 4% pre-market after a competitor's earnings beat suggested margin pressure across the sector — this matters for your semiconductor watchlist.")
- If nothing watchlist-relevant happened, send nothing that day. Build this as an explicit gate in the scheduling job, not an afterthought.

### 3.2 Natural conversation & memory
- Full conversational context per user, persisted across sessions.
- When a request is ambiguous ("tell me about Apple"), the model should ask what angle they want (news / financials / valuation / filings / overview) rather than guessing — but only when genuinely ambiguous; don't over-clarify simple requests.
- Use the model's tool-calling to decide when to pull live data vs. answer from memory/context.

### 3.3 Company & market research
Company profiles, business overview, financial performance, earnings summaries, recent news, leadership changes, funding activity, M&A, regulatory filings, market sentiment, industry trends, competitor comparisons — all synthesized conversationally, sourced from the live data providers above, never dumped as raw data.

### 3.4 Financial document intelligence
User uploads a document (image or file) — annual reports, quarterly reports, earnings decks, statements, filings, diligence docs — and asks questions naturally. Support: summarization, explaining performance, comparing two documents, extracting key insights, highlighting changes between two versions of the same filing, generating an executive summary. Chunk + embed + retrieve (RAG) for anything beyond a few pages; don't just stuff a whole 10-K into context.

### 3.5 Live financial information
Stock prices, news, earnings releases, economic events, filings, market performance, analyst activity — always synthesized into a short, actionable answer, never a link dump. State uncertainty plainly when a data source is stale or unconfirmed rather than presenting it as fact.

### 3.6 Integrations in practice
- **Gmail:** summarize company-related email threads, extract action items, surface relevant context automatically when a company you're discussing also appears in the inbox.
- **Calendar:** meeting prep, reminders (e.g., "remind me 1 hour before Apple's earnings call").
- **Drive/Sheets:** analyze linked spreadsheets — explain models, review KPIs, compare forecasts, detect anomalies.

---

## 4. Creative differentiators (build these after the core above is solid — they're what separates a submission from a winning one)

Pick 2–4 of these to implement well rather than all of them half-built. All are conversational-only, no UI chrome, and all reinforce the finance-vertical depth criterion:

1. **Portfolio Pulse** — user just tells Atlas what they hold in plain language ("50 AAPL, 20 TSLA, $10k in a semis ETF"). Atlas maintains a lightweight portfolio model and proactively flags concentration risk, correlated exposure, or when a watchlist event actually affects their real money — not just abstract news.
2. **Meeting Prep Autopilot** — when Calendar is connected, Atlas detects a meeting with an external party/company and proactively sends a short prep brief beforehand (recent news, filings, financials on that company) without being asked — a genuine "does the work before I know I need it" moment.
3. **Filing Diff-Checker** — using SEC EDGAR, when a followed company files a new 10-K/10-Q, Atlas automatically diffs it against the prior filing and calls out materially changed risk-factor language, not just "a new filing was posted." This is a strong, defensible use of a free data source that most submissions won't bother building.
4. **Devil's Advocate mode** — when a user shares an investment thesis or asks "should I buy X," Atlas doesn't just answer — it proactively raises the strongest counter-argument or overlooked risk before giving its take. Signals real analytical judgment rather than sentiment-following.
5. **Voice earnings-call digest** — user forwards a voice memo or audio clip from an earnings call; Atlas transcribes via Groq Whisper and returns a five-point summary with tone/sentiment notes. Strong use of the voice-input requirement beyond simple dictation.

---

## 5. Personalization loop

Every capability above should feed back into the `UserProfile`: watchlists grow from what gets discussed, briefing schedule adjusts if a user reacts poorly to timing, recurring questions become anticipated topics. Personalization should visibly compound over the course of a demo — the third conversation should feel noticeably sharper than the first.

---

## 6. Engineering expectations

- Clean modular structure: separate layers for Telegram I/O, conversation/orchestration, tool implementations (each data source as its own tool), scheduling, and persistence.
- Each external data source and integration implemented as a discrete, swappable "tool" the LLM can call — not hardcoded branching logic.
- Environment-based config for all API keys; nothing hardcoded.
- Background jobs cleanly separated from the request/response path.
- Git from the first commit, meaningful commit history — this is visible engineering-quality signal even without a full source submission.

---

## 7. What NOT to build

- No onboarding forms, no settings menus, no inline keyboards, no slash commands.
- No feature that exists just to pad the integration count — every integration must have a clear "this saves the user time" justification, stated in the README.
- No long, scrollable wall-of-text responses — summarize, then offer to expand.
- No forwarding raw headlines without explaining relevance.

---

## 8. Deliverables to produce at the end

1. A live, functioning Telegram bot judges can talk to directly.
2. A short demo video walking through: onboarding conversation → a proactive daily brief → a natural research question → a document upload + Q&A → at least one creative differentiator feature in action.
3. A concise README explaining architecture, data sources used and why, and how personalization compounds over a conversation.

---

**Start by scaffolding the project structure and the Telegram + Groq conversational loop first (sections 1–3.2), get that feeling natural and fast, then layer in research/document/live-data tools (3.3–3.6), then the creative differentiators (section 4) last.**
