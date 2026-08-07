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

const KNOWN_CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'DOT', 'AVAX', 'LINK',
  'SHIB', 'MATIC', 'PEPE', 'UNI', 'LTC', 'BCH', 'NEAR', 'APT', 'SUI'
]);

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
  if (KNOWN_CRYPTO.has(symbol)) {
    symbol = `${symbol}-USD`;
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
  const symbol = ticker.toUpperCase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const historical: any[] = await withTimeout(
    yahooFinance.historical(symbol, {
      period1: getPeriodStart(period),
      interval: '1mo',
    }),
    6000,
    'Yahoo historical'
  );

  if (!historical || historical.length < 2) {
    return `Insufficient historical data for ${symbol}.`;
  }

  const first: number = historical[0].close;
  const last: number = historical[historical.length - 1].close;
  const returnPct = (((last - first) / first) * 100).toFixed(1);
  const label: Record<string, string> = {
    '1mo': '1 month', '3mo': '3 months', '6mo': '6 months', '1y': '1 year', '2y': '2 years',
  };

  return `${symbol} ${label[period]} return: ${Number(returnPct) >= 0 ? '+' : ''}${returnPct}% ($${first.toFixed(2)} → $${last.toFixed(2)})`;
}

function getPeriodStart(period: string): string {
  const now = new Date();
  const months: Record<string, number> = {
    '1mo': 1, '3mo': 3, '6mo': 6, '1y': 12, '2y': 24,
  };
  now.setMonth(now.getMonth() - (months[period] || 12));
  return now.toISOString().split('T')[0];
}
