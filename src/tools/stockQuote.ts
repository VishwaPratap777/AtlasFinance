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

export async function getQuote(ticker: string): Promise<QuoteResult> {
  const symbol = ticker.toUpperCase();
  const { data } = await axios.get(`${BASE}/quote`, {
    params: { symbol },
    headers: finnhubHeaders(),
  });

  if (!data || data.c === 0) {
    throw new Error(`No quote data available for ${symbol}`);
  }

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
