import axios from 'axios';
import { env } from '../config/env';

const AV_BASE = 'https://www.alphavantage.co/query';

export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function getDailyPrices(
  ticker: string,
  outputsize: 'compact' | 'full' = 'compact'
): Promise<PriceBar[]> {
  const { data } = await axios.get(AV_BASE, {
    params: {
      function: 'TIME_SERIES_DAILY',
      symbol: ticker.toUpperCase(),
      outputsize,
      apikey: env.ALPHA_VANTAGE_API_KEY,
    },
  });

  if (data['Note'] || data['Information']) {
    throw new Error('Alpha Vantage rate limit reached');
  }

  const ts = data['Time Series (Daily)'];
  if (!ts) throw new Error(`No price data for ${ticker}`);

  return Object.entries(ts)
    .map(([date, values]) => {
      const v = values as Record<string, string>;
      return {
        date,
        open: parseFloat(v['1. open']),
        high: parseFloat(v['2. high']),
        low: parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
        volume: parseInt(v['5. volume']),
      };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// Simple performance summary
export function summarizePerformance(bars: PriceBar[]): string {
  if (bars.length < 2) return 'Insufficient price data.';

  const latest = bars[0];
  const oneWeekAgo = bars[Math.min(5, bars.length - 1)];
  const oneMonthAgo = bars[Math.min(21, bars.length - 1)];
  const threeMonthsAgo = bars[Math.min(63, bars.length - 1)];

  const pct = (from: number, to: number) =>
    (((to - from) / from) * 100).toFixed(1) + '%';

  return (
    `Price performance (as of ${latest.date}):\n` +
    `- 1W: ${pct(oneWeekAgo.close, latest.close)}\n` +
    `- 1M: ${pct(oneMonthAgo.close, latest.close)}\n` +
    `- 3M: ${pct(threeMonthsAgo.close, latest.close)}`
  );
}
