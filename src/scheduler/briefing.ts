import { Telegraf } from 'telegraf';
import { UserProfile } from '../models/UserProfile';
import { getQuote } from '../tools/stockQuote';
import { getCompanyNews, getMarketNews } from '../tools/news';
import { getRecentFilings, getFilingText, getCIK } from '../tools/secFilings';
import { getEarningsCalendar } from '../tools/earnings';
import { chat } from '../orchestrator/llm';
import { getUserProfile } from '../orchestrator/conversation';

// ─── Generate morning brief for a user ──────────────────────────────────────
export async function generateMorningBrief(telegramId: number): Promise<string | null> {
  const profile = await getUserProfile(telegramId);
  if (!profile || !profile.briefingEnabled) return null;

  const tickers = profile.watchlist.map((w) => w.ticker);
  if (tickers.length === 0 && profile.sectors.length === 0) return null;

  const sections: string[] = [];

  // Market overview
  try {
    const marketNews = await getMarketNews('general', 5);
    if (marketNews.length > 0) {
      sections.push(
        'MARKET NEWS:\n' +
          marketNews
            .slice(0, 3)
            .map((n) => `- ${n.headline}`)
            .join('\n')
      );
    }
  } catch { /* ignore */ }

  // Watchlist quotes + news
  const watchlistUpdates: string[] = [];
  for (const ticker of tickers.slice(0, 5)) {
    try {
      const [quote, news] = await Promise.allSettled([
        getQuote(ticker),
        getCompanyNews(ticker, 1),
      ]);

      const q = quote.status === 'fulfilled' ? quote.value : null;
      const n = news.status === 'fulfilled' ? news.value : [];

      let update = '';
      if (q) {
        const dir = q.changePercent >= 0 ? '▲' : '▼';
        update += `*${ticker}* ${dir} ${q.changePercent.toFixed(1)}% ($${q.price.toFixed(2)})`;
      }
      if (n.length > 0) {
        update += `\n  → ${n[0].headline}`;
      }
      if (update) watchlistUpdates.push(update);
    } catch { /* ignore */ }
  }

  if (watchlistUpdates.length > 0) {
    sections.push('YOUR WATCHLIST:\n' + watchlistUpdates.join('\n\n'));
  }

  // Upcoming earnings
  try {
    const earnings = await getEarningsCalendar(tickers, 7);
    if (earnings.length > 0) {
      const earningsStr = earnings
        .slice(0, 3)
        .map((e) => `- *${e.symbol}* reports ${e.date}`)
        .join('\n');
      sections.push('EARNINGS THIS WEEK:\n' + earningsStr);
    }
  } catch { /* ignore */ }

  if (sections.length === 0) return null;

  // Ask LLM to synthesize into a tight brief
  const rawData = sections.join('\n\n---\n\n');
  const messages = [
    {
      role: 'system' as const,
      content: `You are Atlas, a financial assistant. Write a very concise morning brief (max 5 bullet points total) based on the data below. 
- Only include what's genuinely noteworthy — skip filler 
- For each item, explain WHY it matters, not just what happened
- Use Telegram Markdown (*bold* for tickers, no tables)
- End with one key thing to watch today`,
    },
    {
      role: 'user' as const,
      content: `User's profile: Role: ${profile.role || 'investor'}, Sectors: ${profile.sectors.join(', ') || 'general'}\n\nData:\n${rawData}\n\nWrite the morning brief.`,
    },
  ];

  try {
    const response = await chat(messages);
    return response.content;
  } catch {
    // Fallback: return raw data if LLM fails
    return sections.join('\n\n');
  }
}

// ─── Check for significant watchlist moves ───────────────────────────────────
export async function checkWatchlistAlerts(
  telegramId: number
): Promise<{ ticker: string; changePercent: number; price: number }[]> {
  const profile = await getUserProfile(telegramId);
  if (!profile || profile.watchlist.length === 0) return [];

  const alerts: { ticker: string; changePercent: number; price: number }[] = [];

  for (const item of profile.watchlist) {
    try {
      const quote = await getQuote(item.ticker);
      const threshold = item.alertThreshold ?? 5;
      if (Math.abs(quote.changePercent) >= threshold) {
        alerts.push({
          ticker: item.ticker,
          changePercent: quote.changePercent,
          price: quote.price,
        });
      }
    } catch { /* ignore */ }
  }

  return alerts;
}

// ─── Portfolio Pulse: concentration & correlation risk ───────────────────────
export async function generatePortfolioPulse(telegramId: number): Promise<string | null> {
  const profile = await getUserProfile(telegramId);
  if (!profile || profile.portfolio.length === 0) return null;

  const quotes: { ticker: string; changePercent: number; price: number; shares: number }[] = [];

  for (const holding of profile.portfolio) {
    try {
      const q = await getQuote(holding.ticker);
      quotes.push({ ...q, shares: holding.shares });
    } catch { /* ignore */ }
  }

  if (quotes.length === 0) return null;

  const totalValue = quotes.reduce((sum, q) => sum + q.price * q.shares, 0);
  const positions = quotes
    .map((q) => ({
      ticker: q.ticker,
      value: q.price * q.shares,
      weight: ((q.price * q.shares) / totalValue) * 100,
      changePercent: q.changePercent,
    }))
    .sort((a, b) => b.weight - a.weight);

  // Build a portfolio summary for LLM analysis
  const summary = positions
    .map((p) => `${p.ticker}: ${p.weight.toFixed(1)}% of portfolio (${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(1)}% today)`)
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content: `You are Atlas. Analyze this portfolio snapshot and identify:
1. Any concerning concentration (>40% in one position)
2. Correlated exposure (multiple positions moving together)  
3. Notable movers today and why they matter
Be concise — 3-4 bullet points max. Only flag real issues, not imaginary ones.`,
    },
    {
      role: 'user' as const,
      content: `Portfolio (total ~$${totalValue.toFixed(0)}):\n${summary}`,
    },
  ];

  try {
    const response = await chat(messages);
    return `📊 *Portfolio Pulse*\n\n${response.content}`;
  } catch {
    return null;
  }
}

// ─── Filing Diff-Checker ──────────────────────────────────────────────────────
export async function checkFilingDiff(
  ticker: string,
  bot: Telegraf,
  telegramId: number
): Promise<void> {
  try {
    const cik = await getCIK(ticker);
    if (!cik) return;

    // Get two most recent 10-K/10-Q filings
    const filings = await getRecentFilings(ticker, ['10-K', '10-Q'], 2);
    if (filings.length < 2) return;

    const [latest, previous] = filings;

    // Get text of both (first 15k chars each, focused on risk factors)
    const [latestText, prevText] = await Promise.allSettled([
      getFilingText(cik, latest.accessionNumber, latest.primaryDocument),
      getFilingText(cik, previous.accessionNumber, previous.primaryDocument),
    ]);

    if (latestText.status !== 'fulfilled' || prevText.status !== 'fulfilled') return;

    // Extract risk factor sections
    const extractRiskFactors = (text: string): string => {
      const riskStart = text.search(/ITEM\s+1A[\s\S]{0,20}RISK FACTOR/i);
      const riskEnd = text.search(/ITEM\s+1B[\s\S]{0,20}UNRESOLVED/i);
      if (riskStart === -1) return text.substring(0, 8000);
      const end = riskEnd === -1 ? riskStart + 8000 : Math.min(riskEnd, riskStart + 8000);
      return text.substring(riskStart, end);
    };

    const latestRisk = extractRiskFactors(latestText.value);
    const prevRisk = extractRiskFactors(prevText.value);

    const messages = [
      {
        role: 'system' as const,
        content: `You are Atlas. You're comparing two SEC filings for ${ticker} to identify materially changed risk language. 
Focus ONLY on:
- New risks added that weren't in the previous filing
- Risks that were significantly expanded or escalated  
- Risks that were removed or softened

Be specific about what changed and why it might matter. Max 4 bullet points. If nothing material changed, say so plainly.`,
      },
      {
        role: 'user' as const,
        content: `PREVIOUS ${previous.formType} (${previous.filingDate}) risk factors:\n${prevRisk.substring(0, 3000)}\n\n---\n\nLATEST ${latest.formType} (${latest.filingDate}) risk factors:\n${latestRisk.substring(0, 3000)}`,
      },
    ];

    const response = await chat(messages);
    const message = `📋 *${ticker} Filing Alert — ${latest.formType} (${latest.filingDate})*\n\nRisk factor changes vs previous filing:\n\n${response.content}`;

    await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`[FilingDiff] Error for ${ticker}:`, (err as Error).message);
  }
}
