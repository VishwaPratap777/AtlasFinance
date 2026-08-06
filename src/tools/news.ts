import axios from 'axios';
import { env } from '../config/env';

const BASE = 'https://finnhub.io/api/v1';
const headers = () => ({ 'X-Finnhub-Token': env.FINNHUB_API_KEY });

export interface NewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number;
  related?: string;
}

// ─── Company-specific news ─────────────────────────────────────────────────────
export async function getCompanyNews(ticker: string, days = 3): Promise<NewsItem[]> {
  const symbol = ticker.toUpperCase();
  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  const { data } = await axios.get(`${BASE}/company-news`, {
    params: { symbol, from, to },
    headers: headers(),
  });

  if (!Array.isArray(data)) return [];

  return data
    .filter((item: { headline?: string; summary?: string }) => item.headline && item.summary)
    .slice(0, 10)
    .map(
      (item: {
        headline: string;
        summary: string;
        source: string;
        url: string;
        datetime: number;
        related: string;
      }) => ({
        headline: item.headline,
        summary: item.summary?.substring(0, 300),
        source: item.source,
        url: item.url,
        datetime: item.datetime,
        related: item.related,
      })
    );
}

// ─── General market news ───────────────────────────────────────────────────────
export async function getMarketNews(
  category: 'general' | 'forex' | 'crypto' | 'merger' = 'general',
  limit = 10
): Promise<NewsItem[]> {
  const { data } = await axios.get(`${BASE}/news`, {
    params: { category },
    headers: headers(),
  });

  if (!Array.isArray(data)) return [];

  return data
    .filter((item: { headline?: string; summary?: string }) => item.headline && item.summary)
    .slice(0, limit)
    .map(
      (item: {
        headline: string;
        summary: string;
        source: string;
        url: string;
        datetime: number;
      }) => ({
        headline: item.headline,
        summary: item.summary?.substring(0, 300),
        source: item.source,
        url: item.url,
        datetime: item.datetime,
      })
    );
}

// Format news for display (without raw link dump — model should synthesize these)
export function formatNewsItems(items: NewsItem[], maxItems = 5): string {
  if (items.length === 0) return 'No recent news found.';

  return items
    .slice(0, maxItems)
    .map((item) => {
      const date = new Date(item.datetime * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      return `📰 *${item.headline}*\n_${date} · ${item.source}_\n${item.summary}`;
    })
    .join('\n\n');
}

// ─── Analyst ratings ──────────────────────────────────────────────────────────
export async function getAnalystRatings(ticker: string): Promise<string> {
  const symbol = ticker.toUpperCase();
  try {
    const { data } = await axios.get(`${BASE}/stock/recommendation`, {
      params: { symbol },
      headers: headers(),
    });

    if (!Array.isArray(data) || data.length === 0) {
      return `No analyst ratings available for ${symbol}.`;
    }

    const latest = data[0];
    return (
      `Analyst consensus for *${symbol}* (${latest.period}):\n` +
      `- Strong Buy: ${latest.strongBuy}\n` +
      `- Buy: ${latest.buy}\n` +
      `- Hold: ${latest.hold}\n` +
      `- Sell: ${latest.sell}\n` +
      `- Strong Sell: ${latest.strongSell}`
    );
  } catch {
    return `Analyst recommendations for ${symbol} are restricted on Finnhub free tier. Use company fundamentals or price history instead.`;
  }
}

// ─── Price target ─────────────────────────────────────────────────────────────
export async function getPriceTarget(ticker: string): Promise<string> {
  const symbol = ticker.toUpperCase();
  try {
    const { data } = await axios.get(`${BASE}/stock/price-target`, {
      params: { symbol },
      headers: headers(),
    });

    if (!data || !data.targetMean) return `No price target data for ${symbol}.`;

    return (
      `Analyst price targets for *${symbol}*:\n` +
      `- Mean: $${data.targetMean?.toFixed(2)}\n` +
      `- High: $${data.targetHigh?.toFixed(2)}\n` +
      `- Low: $${data.targetLow?.toFixed(2)}\n` +
      `- Last updated: ${data.lastUpdated}`
    );
  } catch {
    return `Price target data for ${symbol} is unavailable on free tier.`;
  }
}
