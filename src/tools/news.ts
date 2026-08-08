import axios from 'axios';
import { env } from '../config/env';
import { getCache, setCache } from '../config/redis';

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
  const cached = await getCache<NewsItem[]>(`cnews:${symbol}:${days}`);
  if (cached) return cached;

  const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  const to = new Date().toISOString().split('T')[0];

  const { data } = await axios.get(`${BASE}/company-news`, {
    params: { symbol, from, to },
    headers: headers(),
    timeout: 4000,
  });

  if (!Array.isArray(data)) return [];

  const items: NewsItem[] = data
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

  await setCache(`cnews:${symbol}:${days}`, items, 900); // 15 min TTL
  return items;
}

// ─── General market news ───────────────────────────────────────────────────────
export async function getMarketNews(
  category: 'general' | 'forex' | 'crypto' | 'merger' = 'general',
  limit = 10
): Promise<NewsItem[]> {
  const cached = await getCache<NewsItem[]>(`mnews:${category}:${limit}`);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/news`, {
    params: { category },
    headers: headers(),
    timeout: 4000,
  });

  if (!Array.isArray(data)) return [];

  const items: NewsItem[] = data
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

  await setCache(`mnews:${category}:${limit}`, items, 900); // 15 min TTL
  return items;
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
  const cached = await getCache<string>(`ratings:${symbol}`);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${BASE}/stock/recommendation`, {
      params: { symbol },
      headers: headers(),
      timeout: 4000,
    });

    if (!Array.isArray(data) || data.length === 0) {
      const msg = `No analyst ratings available for ${symbol}.`;
      await setCache(`ratings:${symbol}`, msg, 3600);
      return msg;
    }

    const latest = data[0];
    const res = (
      `Analyst consensus for *${symbol}* (${latest.period}):\n` +
      `- Strong Buy: ${latest.strongBuy}\n` +
      `- Buy: ${latest.buy}\n` +
      `- Hold: ${latest.hold}\n` +
      `- Sell: ${latest.sell}\n` +
      `- Strong Sell: ${latest.strongSell}`
    );
    await setCache(`ratings:${symbol}`, res, 3600); // 1 hour TTL
    return res;
  } catch {
    return `Analyst recommendations for ${symbol} are restricted on Finnhub free tier. Use company fundamentals or price history instead.`;
  }
}

// ─── Price target ─────────────────────────────────────────────────────────────
export async function getPriceTarget(ticker: string): Promise<string> {
  const symbol = ticker.toUpperCase();
  const cached = await getCache<string>(`ptarget:${symbol}`);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${BASE}/stock/price-target`, {
      params: { symbol },
      headers: headers(),
      timeout: 4000,
    });

    if (!data || !data.targetMean) {
      const msg = `No price target data for ${symbol}.`;
      await setCache(`ptarget:${symbol}`, msg, 3600);
      return msg;
    }

    const res = (
      `Analyst price targets for *${symbol}*:\n` +
      `- Mean: $${data.targetMean?.toFixed(2)}\n` +
      `- High: $${data.targetHigh?.toFixed(2)}\n` +
      `- Low: $${data.targetLow?.toFixed(2)}\n` +
      `- Last updated: ${data.lastUpdated}`
    );
    await setCache(`ptarget:${symbol}`, res, 3600); // 1 hour TTL
    return res;
  } catch {
    return `Price target data for ${symbol} is unavailable on free tier.`;
  }
}

