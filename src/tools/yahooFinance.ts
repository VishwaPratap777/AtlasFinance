import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// yahoo-finance2 uses fetch internally and doesn't reliably honor a timeout option,
// so bound every call — a hung upstream must never stall the Telegram reply.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export interface QuickSummary {
  ticker: string;
  name: string;
  price: number;
  changePercent: number;
  marketCap?: number;
  peRatio?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  averageVolume?: number;
  description?: string;
}

import { KNOWN_CRYPTO } from './stockQuote';

import axios from 'axios';

export async function fetchYahooChartV8(symbol: string): Promise<QuickSummary | null> {
  try {
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      params: { interval: '1d', range: '1d' },
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    const meta = data?.chart?.result?.[0]?.meta;
    if (meta && (meta.regularMarketPrice || meta.chartPreviousClose)) {
      const price = meta.regularMarketPrice || meta.chartPreviousClose || 0;
      const prevClose = meta.chartPreviousClose || meta.previousClose || price;
      const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

      return {
        ticker: symbol,
        name: meta.shortName || meta.symbol || symbol,
        price,
        changePercent,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || meta.regularMarketDayHigh || price,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || meta.regularMarketDayLow || price,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export async function quickLookup(ticker: string): Promise<QuickSummary> {
  let symbol = ticker.toUpperCase().trim();
  // Normalise crypto to base-USD form without double-suffixing.
  // Strip any existing -USD or USD suffix first, then re-add cleanly.
  const cryptoBase = symbol.replace(/-USD$/i, '').replace(/USD$/i, '');
  if (KNOWN_CRYPTO.has(symbol) || KNOWN_CRYPTO.has(cryptoBase)) {
    symbol = `${cryptoBase}-USD`;
  }

  // If symbol is an index (starts with ^ like ^BSESN, ^NSEI), try Yahoo Chart V8 API first
  if (symbol.startsWith('^')) {
    const v8Res = await fetchYahooChartV8(symbol);
    if (v8Res && v8Res.price > 0) {
      return v8Res;
    }
  }

  // Single fast query for price and core key metrics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = await withTimeout(yahooFinance.quote(symbol), 5000, 'Yahoo quote').catch(() => null);
  if (q && q.regularMarketPrice) {
    return {
      ticker: symbol,
      name: q.longName || q.shortName || symbol,
      price: q.regularMarketPrice || 0,
      changePercent: q.regularMarketChangePercent || 0,
      marketCap: q.marketCap,
      peRatio: q.trailingPE,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow,
      averageVolume: q.averageDailyVolume3Month || q.averageDailyVolume10Day,
    };
  }

  // Fallback to Chart V8 API if quote failed
  const v8Fallback = await fetchYahooChartV8(symbol);
  if (v8Fallback && v8Fallback.price > 0) {
    return v8Fallback;
  }

  throw new Error(`No Yahoo Finance data for ${symbol}`);
}

export async function getHistoricalReturn(
  ticker: string,
  period: '1mo' | '3mo' | '6mo' | '1y' | '2y' = '1y'
): Promise<string> {
  let symbol = ticker.toUpperCase().trim();
  // Strip any existing -USD / USD suffix before normalising to avoid double-suffixing.
  const baseCrypto = symbol.replace(/-USD$/i, '').replace(/USD$/i, '');
  if (KNOWN_CRYPTO.has(symbol) || KNOWN_CRYPTO.has(baseCrypto)) {
    symbol = `${baseCrypto}-USD`;
  }

  // 1. Try Yahoo Chart V8 API first (fast & reliable)
  try {
    const rangeStr = period;
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      params: { interval: period === '1mo' ? '1d' : '1mo', range: rangeStr },
      timeout: 3500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0];
    const closes = (quotes?.close || []).filter((c: number | null) => c !== null && !isNaN(c) && c > 0);
    const lows = (quotes?.low || []).filter((c: number | null) => c !== null && !isNaN(c) && c > 0);
    const highs = (quotes?.high || []).filter((c: number | null) => c !== null && !isNaN(c) && c > 0);

    if (closes.length >= 2) {
      const first = closes[0];
      const last = closes[closes.length - 1];
      const returnPct = (((last - first) / first) * 100).toFixed(1);
      const returnSign = Number(returnPct) >= 0 ? '+' : '';

      if (period === '1mo') {
        const low30d = lows.length > 0 ? Math.min(...lows) : first;
        const high30d = highs.length > 0 ? Math.max(...highs) : last;
        return `${symbol} 30-day trend: ${returnSign}${returnPct}% ($${first.toFixed(2)} → $${last.toFixed(2)}) | 30-day range: $${low30d.toFixed(2)} low to $${high30d.toFixed(2)} high`;
      }

      return `${symbol} ${period} return: ${returnSign}${returnPct}% ($${first.toFixed(2)} → $${last.toFixed(2)})`;
    }
  } catch {
    // Fall through to yahooFinance library
  }

  // 2. Fallback to yahooFinance.historical library
  try {
    const startDate = getPeriodStartDate(period);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const historical: any[] = await withTimeout(
      yahooFinance.historical(symbol, {
        period1: startDate,
        interval: period === '1mo' ? '1d' : '1mo',
      }),
      5000,
      'Yahoo historical'
    );

    if (historical && historical.length >= 2) {
      const first: number = historical[0].close || historical[0].open || 0;
      const last: number = historical[historical.length - 1].close || 0;
      if (first > 0 && last > 0) {
        const returnPct = (((last - first) / first) * 100).toFixed(1);
        const returnSign = Number(returnPct) >= 0 ? '+' : '';

        if (period === '1mo') {
          const lows = historical.map((b) => b.low || b.close || first).filter((n) => n > 0);
          const highs = historical.map((b) => b.high || b.close || last).filter((n) => n > 0);
          const low30d = Math.min(...lows);
          const high30d = Math.max(...highs);
          return `${symbol} 30-day trend: ${returnSign}${returnPct}% ($${first.toFixed(2)} → $${last.toFixed(2)}) | 30-day range: $${low30d.toFixed(2)} low to $${high30d.toFixed(2)} high`;
        }
        return `${symbol} ${period} return: ${returnSign}${returnPct}% ($${first.toFixed(2)} → $${last.toFixed(2)})`;
      }
    }
  } catch {
    // ignore
  }

  return `30-day historical trend data unavailable for ${symbol}.`;
}

function getPeriodStartDate(period: string): Date {
  const now = new Date();
  const months: Record<string, number> = {
    '1mo': 1, '3mo': 3, '6mo': 6, '1y': 12, '2y': 24,
  };
  now.setMonth(now.getMonth() - (months[period] || 12));
  return now;
}
