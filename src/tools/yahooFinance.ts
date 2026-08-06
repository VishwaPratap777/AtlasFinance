// eslint-disable-next-line @typescript-eslint/no-explicit-any
import yahooFinance from 'yahoo-finance2';

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

export async function quickLookup(ticker: string): Promise<QuickSummary> {
  let symbol = ticker.toUpperCase().trim();
  if (KNOWN_CRYPTO.has(symbol)) {
    symbol = `${symbol}-USD`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [quoteRes, detailRes, profileRes] = await Promise.allSettled<any>([
    yahooFinance.quote(symbol),
    yahooFinance.quoteSummary(symbol, { modules: ['summaryDetail'] as any }),
    yahooFinance.quoteSummary(symbol, { modules: ['assetProfile'] as any }),
  ]);

  const q = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const sd = detailRes.status === 'fulfilled' ? detailRes.value?.summaryDetail : null;
  const ap = profileRes.status === 'fulfilled' ? profileRes.value?.assetProfile : null;

  if (!q) throw new Error(`No Yahoo Finance data for ${symbol}`);

  return {
    ticker: symbol,
    name: q.longName || q.shortName || symbol,
    price: q.regularMarketPrice || 0,
    changePercent: q.regularMarketChangePercent || 0,
    marketCap: q.marketCap,
    peRatio: sd?.trailingPE,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    averageVolume: q.averageDailyVolume3Month,
    description: ap?.longBusinessSummary?.substring(0, 400),
  };
}

export async function getHistoricalReturn(
  ticker: string,
  period: '1mo' | '3mo' | '6mo' | '1y' | '2y' = '1y'
): Promise<string> {
  const symbol = ticker.toUpperCase();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const historical: any[] = await yahooFinance.historical(symbol, {
    period1: getPeriodStart(period),
    interval: '1mo',
  });

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
