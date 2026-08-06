# Atlas — AI Financial Assistant for Telegram

> A sharp, discreet financial analyst that lives inside Telegram. Text it, voice it, send it a PDF — it already knows your portfolio, your watchlist, and your inbox.

---

## Architecture

```
src/
├── bot/                     # Telegram layer (telegraf)
│   ├── index.ts             # Bot init — webhook (prod) / long-polling (dev)
│   └── handlers/
│       ├── message.ts       # Text → agentic tool-calling loop → reply
│       ├── voice.ts         # OGG → Groq Whisper → text → message handler
│       └── document.ts      # PDF/image → extract/analyze → RAG → reply
├── orchestrator/
│   ├── llm.ts               # Groq primary + Gemini fallback; Whisper; vision
│   ├── conversation.ts      # Per-user history, system prompts, DB persistence
│   └── tools.ts             # 15-tool registry for LLM function-calling
├── tools/                   # One file per data source — each is swappable
│   ├── stockQuote.ts        # Finnhub real-time quotes
│   ├── companyProfile.ts    # Finnhub company profile + fundamentals + insider
│   ├── earnings.ts          # Finnhub earnings calendar + EPS history
│   ├── news.ts              # Finnhub news + analyst ratings + price targets
│   ├── secFilings.ts        # SEC EDGAR filings + full-text search
│   ├── alphaVantage.ts      # Alpha Vantage daily price history (fallback)
│   ├── yahooFinance.ts      # Yahoo Finance quick lookup (no-key fallback)
│   ├── gmail.ts             # Gmail read-only thread search
│   ├── calendar.ts          # Google Calendar + meeting prep autopilot
│   └── driveSheets.ts       # Google Sheets analysis + Drive file listing
├── rag/
│   ├── chunker.ts           # Section-aware text chunking
│   ├── embedder.ts          # Jina AI embeddings → @xenova local fallback
│   └── retriever.ts         # Cosine similarity retrieval, document ingestion
├── scheduler/
│   ├── briefing.ts          # Brief generator, portfolio pulse, filing diff
│   └── jobs.ts              # node-cron: morning briefs, alerts, earnings, filings
├── models/                  # Mongoose schemas
│   ├── UserProfile.ts       # Prefs, watchlist, portfolio, Google tokens
│   ├── Conversation.ts      # Message history (trimmed to last 100)
│   └── DocumentChunk.ts     # RAG chunks with embeddings
└── config/
    └── env.ts               # Zod-validated environment variables
```

---

## Data Sources & Rationale

| Source | Used For | Why |
|--------|----------|-----|
| **Finnhub** (free tier) | Quotes, company profiles, earnings, news, analyst ratings, insider transactions | Best single free API for breadth — real-time-ish data, generous limits |
| **SEC EDGAR** (no key) | 10-K, 10-Q, 8-K, Form 4 filings; full-text search | Free, authoritative, defensible source. Real regulatory data, not summaries. |
| **Alpha Vantage** (free tier) | Price history fallback | Reliable backup when Finnhub rate limits hit |
| **Yahoo Finance** (no key) | Quick price/summary lookups | Zero-cost secondary fallback via `yahoo-finance2` package |
| **Google APIs** | Gmail, Calendar, Drive/Sheets — optional | Workspace integration for email context, meeting prep, spreadsheet analysis |

---

## AI / LLM Stack

| Component | Provider | Model | Rationale |
|-----------|----------|-------|-----------|
| Conversation | Groq (primary) | `llama-3.3-70b-versatile` | Lowest latency for chat UX — responses feel instant in Telegram |
| Conversation fallback | Gemini (backup) | `gemini-2.5-flash` | Provider resilience; generous free tier |
| Voice transcription | Groq | `whisper-large-v3-turbo` | Same provider, free tier, dramatically faster than alternatives |
| Image / document vision | Groq → Gemini | `llama-4-scout` → `gemini-2.5-flash` | Progressive capability with fallback |
| Embeddings | Jina AI → local | `jina-embeddings-v3` → `all-MiniLM-L6-v2` | Zero cost at all times; local fallback requires no API call |

---

## Creative Differentiators

### 1. Portfolio Pulse
User tells Atlas what they hold in plain language ("50 AAPL, 20 TSLA, $10k in a semis ETF"). Atlas maintains the portfolio, surfaces concentration risk, and proactively flags when a watchlist event affects real money.

### 2. Meeting Prep Autopilot
When Google Calendar is connected, Atlas checks upcoming meetings for external company names from your watchlist. If it finds one, it auto-sends a prep brief (recent news, filings, financials) before you need to ask — genuine "does the work before I know I need it."

### 3. Filing Diff-Checker
When a followed company files a new 10-K or 10-Q, Atlas fetches both the new and previous filing from EDGAR, extracts the risk factor sections, and runs an LLM diff to flag materially changed language — not just "a new filing was posted." Uses EDGAR's free API; no third-party data vendor needed.

---

## Personalization Loop

Every capability feeds back into `UserProfile`:
- Tickers mentioned in conversation → added to watchlist
- Questions asked repeatedly → tracked as anticipated topics
- Briefing timing adjusted based on engagement patterns
- Portfolio updated from natural language ("I just bought 100 shares of NVDA")

The third conversation with Atlas should feel noticeably sharper than the first.

---

## Setup

### 1. Clone and install
```bash
git clone <repo>
cd atlas
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your API keys
```

Required keys:
- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `GROQ_API_KEY` — from [console.groq.com](https://console.groq.com)
- `MONGODB_URI` — MongoDB Atlas free cluster
- `FINNHUB_API_KEY` — from [finnhub.io](https://finnhub.io)

Optional (enables Google integrations):
- `GEMINI_API_KEY`, `JINA_API_KEY`, `ALPHA_VANTAGE_API_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`

### 3. Run in development
```bash
npm run dev
```

### 4. Deploy to production (Render/Railway)
```bash
npm run build
npm start
# Set WEBHOOK_URL and NODE_ENV=production in environment
```

---

## Design Principles

- **No slash commands, no buttons, no menus** — every feature is accessible through natural language
- **Silence is valid** — proactive updates only send when there's something genuinely worth saying
- **Depth over breadth** — 3 well-integrated data sources beat 10 shallow ones
- **Uncertainty is explicit** — stale data is labeled, unconfirmed info is flagged
- **Concise by default** — summarize first, offer to go deeper

---

## What NOT included

Per the brief: no onboarding forms, no settings menus, no inline keyboards, no slash commands, no raw headline dumps without context.
