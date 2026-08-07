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
  'SHIB', 'MATIC', 'PEPE', 'UNI', 'LTC', 'BCH', 'NEAR', 'APT', 'SUI',
  'BTC-USD', 'ETH-USD', 'SOL-USD'
]);

const CRYPTO_NAME_MAP: Record<string, string> = {
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
  DOGECOIN: 'DOGE',
  RIPPLE: 'XRP',
  CARDANO: 'ADA',
  AVALANCHE: 'AVAX',
  CHAINLINK: 'LINK',
  SHIBA: 'SHIB',
  POLYGON: 'MATIC',
  PEPE: 'PEPE',
  UNISWAP: 'UNI',
  LITECOIN: 'LTC',
};

// ─── Global ticker/index alias resolution ──────────────────────────────────────
const TICKER_ALIAS_MAP: Record<string, string> = {
  // Indian Indices
  NIFTY: '^NSEI',
  'NIFTY50': '^NSEI',
  'NIFTY 50': '^NSEI',
  SENSEX: '^BSESN',
  BSE: '^BSESN',
  BANKNIFTY: '^NSEBANK',
  'BANK NIFTY': '^NSEBANK',
  NIFTYBANK: '^NSEBANK',
  MIDCAP: '^NSEI', // approximate
  // US Indices
  'SP500': '^GSPC',
  'S&P500': '^GSPC',
  'S&P 500': '^GSPC',
  'SPX': '^GSPC',
  DOW: '^DJI',
  DOWJONES: '^DJI',
  'DOW JONES': '^DJI',
  NASDAQ: '^IXIC',
  NASDAQ100: '^NDX',
  'NDX': '^NDX',
  VIX: '^VIX',
  // Global
  FTSE: '^FTSE',
  'FTSE100': '^FTSE',
  NIKKEI: '^N225',
  'NIKKEI225': '^N225',
  HANGSENG: '^HSI',
  DAX: '^GDAXI',
  CAC: '^FCHI',
  'CAC40': '^FCHI',
  // Commodities (Yahoo Finance)
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  OIL: 'CL=F',
  CRUDEOIL: 'CL=F',
  'CRUDE OIL': 'CL=F',
  NATURALGAS: 'NG=F',
  // US Popular Companies & Name Aliases
  TESLA: 'TSLA',
  APPLE: 'AAPL',
  MICROSOFT: 'MSFT',
  NVIDIA: 'NVDA',
  AMAZON: 'AMZN',
  GOOGLE: 'GOOGL',
  ALPHABET: 'GOOGL',
  META: 'META',
  FACEBOOK: 'META',
  NETFLIX: 'NFLX',
  AMD: 'AMD',
  INTEL: 'INTC',
  PALANTIR: 'PLTR',
  COINBASE: 'COIN',
  BERKSHIRE: 'BRK-B',
  DISNEY: 'DIS',
  UBER: 'UBER',
  AIRBNB: 'ABNB',
  BOEING: 'BA',
  WALMART: 'WMT',
  SUPERMICRO: 'SMCI',
  ROBLOX: 'RBLX',
  MICROSTRATEGY: 'MSTR',
  ARM: 'ARM',
  BROADCOM: 'AVGO',
};

// ─── Detect if a symbol is an Indian instrument ────────────────────────────────
function isIndianSymbol(symbol: string): boolean {
  return symbol.endsWith('.NS') || symbol.endsWith('.BO') ||
    symbol === '^NSEI' || symbol === '^BSESN' || symbol === '^NSEBANK';
}

// ─── Detect if symbol is a non-USD index/commodity ────────────────────────────
function getCurrencySymbol(symbol: string): string {
  if (isIndianSymbol(symbol)) return '₹';
  return '$';
}

import { getCache, setCache } from '../config/redis';

async function fetchBinanceCrypto(rawSymbol: string): Promise<QuoteResult | null> {
  try {
    const base = rawSymbol.replace('-USD', '').replace('USD', '').toUpperCase();
    const pair = `${base}USDT`;
    const { data } = await axios.get(`https://api.binance.com/api/v3/ticker/24hr`, {
      params: { symbol: pair },
      timeout: 3500,
    });
    if (data && data.lastPrice) {
      const price = parseFloat(data.lastPrice);
      const change = parseFloat(data.priceChange);
      const changePercent = parseFloat(data.priceChangePercent);
      const high = parseFloat(data.highPrice);
      const low = parseFloat(data.lowPrice);
      const open = parseFloat(data.openPrice);
      const previousClose = parseFloat(data.prevClosePrice);

      return {
        ticker: `${base}-USD`,
        price,
        change,
        changePercent,
        high,
        low,
        open,
        previousClose,
        timestamp: new Date().toISOString(),
      };
    }
  } catch {
    // fallback
  }
  return null;
}

async function searchFinnhubTicker(query: string): Promise<string | null> {
  try {
    const { data } = await axios.get(`${BASE}/search`, {
      params: { q: query },
      headers: finnhubHeaders(),
      timeout: 2500,
    });
    if (data && data.result && data.result.length > 0) {
      const match = data.result.find(
        (r: { symbol: string; type?: string }) => r.type === 'Common Stock' || !r.symbol.includes('.')
      );
      return match ? match.symbol : data.result[0].symbol;
    }
  } catch {
    // fallback
  }
  return null;
}

export async function getQuote(ticker: string): Promise<QuoteResult> {
  let symbol = ticker.toUpperCase().trim();
  
  // Resolve full crypto names (e.g. BITCOIN -> BTC)
  if (CRYPTO_NAME_MAP[symbol]) {
    symbol = CRYPTO_NAME_MAP[symbol];
  }

  // Resolve index/commodity/market aliases (e.g. NIFTY -> ^NSEI, TESLA -> TSLA)
  if (TICKER_ALIAS_MAP[symbol]) {
    symbol = TICKER_ALIAS_MAP[symbol];
  }

  const isCrypto = KNOWN_CRYPTO.has(symbol) || symbol.endsWith('-USD');
  if (isCrypto) {
    const cleanBase = symbol.replace('-USD', '');
    symbol = `${cleanBase}-USD`;
  }

  // Check 75s Redis quote cache
  const cachedQuote = await getCache<QuoteResult>(`quote:${symbol}`);
  if (cachedQuote) {
    return cachedQuote;
  }

  // If crypto, try Binance 24hr API first for instant real-time crypto prices
  if (isCrypto) {
    const binanceRes = await fetchBinanceCrypto(symbol);
    if (binanceRes) {
      await setCache(`quote:${symbol}`, binanceRes, 75);
      return binanceRes;
    }
  }

  // Try Finnhub (for equities/ETFs)
  try {
    const { data } = await axios.get(`${BASE}/quote`, {
      params: { symbol },
      headers: finnhubHeaders(),
    });

    if (data && data.c && data.c !== 0) {
      const res: QuoteResult = {
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
      await setCache(`quote:${symbol}`, res, 75);
      return res;
    }
  } catch {
    // Fall through to Yahoo Finance
  }

  // Fallback to Yahoo Finance (supports crypto, international stocks, ETFs)
  try {
    const { quickLookup } = await import('./yahooFinance');
    const yahooData = await quickLookup(symbol);

    const res: QuoteResult = {
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
    await setCache(`quote:${symbol}`, res, 75);
    return res;
  } catch (err) {
    // If quote failed and query looks like a company name (not already an index or crypto), try Finnhub symbol search
    if (!symbol.startsWith('^') && !isCrypto) {
      const searchedSymbol = await searchFinnhubTicker(ticker);
      if (searchedSymbol && searchedSymbol !== symbol) {
        return await getQuote(searchedSymbol);
      }
    }
    throw err;
  }
}

// Format quote for Telegram display
export function formatQuote(q: QuoteResult): string {
  const dir = q.changePercent >= 0 ? '▲' : '▼';
  const sign = q.changePercent >= 0 ? '+' : '';
  const cur = getCurrencySymbol(q.ticker);
  // Use integer formatting for large prices (e.g. indices like NIFTY at 24,500)
  const fmt = (n: number) => n >= 1000 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : n.toFixed(2);
  return (
    `*${q.ticker}* — ${cur}${fmt(q.price)}\n` +
    `${dir} ${sign}${q.changePercent.toFixed(2)}% (${sign}${cur}${fmt(q.change)})\n` +
    `H: ${cur}${fmt(q.high)} · L: ${cur}${fmt(q.low)} · Prev close: ${cur}${fmt(q.previousClose)}`
  );
}
