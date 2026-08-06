import axios from 'axios';
import { env } from '../config/env';

const BASE = 'https://finnhub.io/api/v1';
const headers = () => ({ 'X-Finnhub-Token': env.FINNHUB_API_KEY });

export interface EarningsEvent {
  symbol: string;
  date: string;
  hour: 'bmo' | 'amc' | 'dmh' | string; // before market open, after market close, during market hours
  epsEstimate?: number;
  epsActual?: number;
  revenueEstimate?: number;
  revenueActual?: number;
  quarter?: number;
  year?: number;
}

export async function getEarningsCalendar(
  tickers: string[],
  daysAhead = 30
): Promise<EarningsEvent[]> {
  const from = new Date().toISOString().split('T')[0];
  const to = new Date(Date.now() + daysAhead * 86400000).toISOString().split('T')[0];

  const { data } = await axios.get(`${BASE}/calendar/earnings`, {
    params: { from, to },
    headers: headers(),
  });

  const allEvents: EarningsEvent[] = (data?.earningsCalendar || []).map(
    (e: {
      symbol: string;
      date: string;
      hour: string;
      epsEstimate: number;
      epsActual: number;
      revenueEstimate: number;
      revenueActual: number;
      quarter: number;
      year: number;
    }) => ({
      symbol: e.symbol,
      date: e.date,
      hour: e.hour,
      epsEstimate: e.epsEstimate,
      epsActual: e.epsActual,
      revenueEstimate: e.revenueEstimate,
      revenueActual: e.revenueActual,
      quarter: e.quarter,
      year: e.year,
    })
  );

  if (tickers.length === 0) return allEvents.slice(0, 20);

  const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
  return allEvents.filter((e) => tickerSet.has(e.symbol.toUpperCase()));
}

export function formatEarningsEvent(e: EarningsEvent): string {
  const timing = e.hour === 'bmo' ? 'Before open' : e.hour === 'amc' ? 'After close' : e.hour;
  const epsStr = e.epsEstimate != null ? `EPS est: $${e.epsEstimate.toFixed(2)}` : '';
  return `- *${e.symbol}* — ${e.date} (${timing})${epsStr ? ' · ' + epsStr : ''}`;
}

export async function getSurprises(ticker: string, limit = 4): Promise<string> {
  const symbol = ticker.toUpperCase();
  const { data } = await axios.get(`${BASE}/stock/earnings`, {
    params: { symbol, limit },
    headers: headers(),
  });

  if (!Array.isArray(data) || data.length === 0) {
    return `No recent earnings data for ${symbol}.`;
  }

  return data
    .slice(0, limit)
    .map((e: { period: string; actual: number; estimate: number; surprisePercent: number }) => {
      const beat = e.actual >= e.estimate ? '✅' : '❌';
      return `- ${beat} ${e.period}: EPS $${e.actual?.toFixed(2)} vs est $${e.estimate?.toFixed(2)} (${e.surprisePercent?.toFixed(1)}% surprise)`;
    })
    .join('\n');
}
