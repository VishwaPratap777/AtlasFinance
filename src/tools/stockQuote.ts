import axios from 'axios';
import { env } from '../config/env';

const BASE = 'https://finnhub.io/api/v1';

function finnhubHeaders() {
  return { 'X-Finnhub-Token': env.FINNHUB_API_KEY };
}

// ─── Stock Quote ───────────────────────────────────────────────────────────────
export interface QuoteResult {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: string;
}

const KNOWN_CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'DOT', 'AVAX', 'LINK',
  'SHIB', 'MATIC', 'PEPE', 'UNI', 'LTC', 'BCH', 'NEAR', 'APT', 'SUI'
]);

export async function getQuote(ticker: string): Promise<QuoteResult> {
  let symbol = ticker.toUpperCase().trim();
  
  // Normalize crypto tickers (e.g. BTC -> BTC-USD)
  if (KNOWN_CRYPTO.has(symbol)) {
    symbol = `${symbol}-USD`;
  }

  // Try Finnhub first (for equities/ETFs)
  try {
    const { data } = await axios.get(`${BASE}/quote`, {
      params: { symbol },
      headers: finnhubHeaders(),
    });

    if (data && data.c && data.c !== 0) {
      return {
        ticker: symbol,
        price: data.c,
        change: data.d,
        changePercent: data.dp,
        high: data.h,
        low: data.l,
        open: data.o,
        previousClose: data.pc,
        timestamp: new Date(data.t * 1000).toISOString(),
      };
    }
  } catch {
    // Fall through to Yahoo Finance
  }

  // Fallback to Yahoo Finance (supports crypto, international stocks, ETFs)
  const { quickLookup } = await import('./yahooFinance');
  const yahooData = await quickLookup(symbol);

  return {
    ticker: yahooData.ticker,
    price: yahooData.price,
    change: (yahooData.price * (yahooData.changePercent || 0)) / 100,
    changePercent: yahooData.changePercent,
    high: yahooData.fiftyTwoWeekHigh || yahooData.price,
    low: yahooData.fiftyTwoWeekLow || yahooData.price,
    open: yahooData.price,
    previousClose: yahooData.price / (1 + (yahooData.changePercent || 0) / 100),
    timestamp: new Date().toISOString(),
  };
}

// Format quote for Telegram display
export function formatQuote(q: QuoteResult): string {
  const dir = q.changePercent >= 0 ? '▲' : '▼';
  const sign = q.changePercent >= 0 ? '+' : '';
  return (
    `*${q.ticker}* — $${q.price.toFixed(2)}\n` +
    `${dir} ${sign}${q.changePercent.toFixed(2)}% (${sign}$${q.change.toFixed(2)})\n` +
    `H: $${q.high.toFixed(2)} · L: $${q.low.toFixed(2)} · Prev close: $${q.previousClose.toFixed(2)}`
  );
}
