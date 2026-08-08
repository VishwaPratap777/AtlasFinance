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
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'XRP-USD', 'ADA-USD',
  'BTCUSD', 'ETHUSD', 'SOLUSD', 'DOGEUSD', 'XRPUSD', 'ADAUSD'
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
  // Major Banks & Financial Institutions
  'MORGAN STANLEY': 'MS',
  MORGANSTANLEY: 'MS',
  'GOLDMAN SACHS': 'GS',
  GOLDMANSACHS: 'GS',
  GOLDMAN: 'GS',
  'JPMORGAN': 'JPM',
  'JP MORGAN': 'JPM',
  'JPMORGAN CHASE': 'JPM',
  'BANK OF AMERICA': 'BAC',
  BOFA: 'BAC',
  CITIGROUP: 'C',
  CITI: 'C',
  WELLSFARGO: 'WFC',
  'WELLS FARGO': 'WFC',
  BLACKROCK: 'BLK',
  SCHWAB: 'SCHW',
  'CHARLES SCHWAB': 'SCHW',
};

// ─── Detect if a symbol is an Indian instrument ────────────────────────────────
function isIndianSymbol(symbol: string): boolean {
  return symbol.endsWith('.NS') || symbol.endsWith('.BO') ||
    symbol === '^NSEI' || symbol === '^BSESN' || symbol === '^NSEBANK';
}

// ─── Quote-intent detector (forces tool use, blocks price hallucination) ────────
// Common all-caps words that look like tickers but aren't — never treat as symbols.
const TICKER_STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'USD', 'USA', 'CEO', 'CFO', 'ETF', 'IPO', 'GDP',
  'API', 'FAQ', 'NEWS', 'WHAT', 'WHEN', 'WHY', 'HOW', 'WHO', 'BUY', 'SELL',
  'HOLD', 'YES', 'NO', 'OK', 'PE', 'EPS', 'YTD', 'ATH', 'RSI', 'AI', 'OK',
]);

// Words that signal the user wants a live number/market read.
const QUOTE_INTENT_RE =
  /\b(price|quote|worth|trading|value|how('| i)?s|how much|doing|rate|level|movement|move|up|down|rally|dip|crash|pump|dump|chart|market|stock|shares?|ticker|crypto|coin)\b/i;

/**
 * Returns true when the message plausibly asks for a live price/market read on a
 * specific asset — i.e. a turn where the model MUST call get_stock_quote and must
 * never answer from memory. Reuses the same alias/crypto maps the quote resolver uses,
 * so anything getQuote can resolve is detectable here. Deliberately errs toward firing:
 * a false positive just forces a (correct) tool call; a false negative lets the 8B model
 * fabricate a price, which is the bug we're killing.
 */
export function detectQuoteIntent(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();

  // Direct hit: any known crypto token, full crypto name, or ticker/index alias.
  for (const key of Object.keys(CRYPTO_NAME_MAP)) {
    if (new RegExp(`\\b${key}\\b`).test(upper)) return true;
  }
  for (const key of Object.keys(TICKER_ALIAS_MAP)) {
    if (upper.includes(key)) return true;
  }
  for (const sym of KNOWN_CRYPTO) {
    if (new RegExp(`\\b${sym.replace('-', '\\-')}\\b`).test(upper)) return true;
  }

  // Explicit ticker syntax: $AAPL / $BTC.
  if (/\$[A-Z]{1,6}\b/.test(upper)) return true;

  // Caps-shaped tokens must be matched against the ORIGINAL text, not the uppercased
  // copy — the signal is that the USER typed them in caps (a real ticker like NVDA),
  // so uppercasing first would make every short word look like a ticker.
  const capsTokens = (text.match(/\b[A-Z]{2,5}\b/g) || []).filter(
    (w) => !TICKER_STOPWORDS.has(w)
  );

  // A user-typed ALL-CAPS token paired with quote-intent language: "how's TSLA".
  if (QUOTE_INTENT_RE.test(text) && capsTokens.length > 0) return true;

  // Lone ticker with no other intent words: a short message (≤2 words) that is
  // essentially just a ticker-shaped token, e.g. "NVDA" or "AAPL?". Bounded to short
  // messages so stray caps mid-sentence don't force a needless tool call.
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 2 && capsTokens.length > 0) return true;

  return false;
}

// ─── Guards that force a turn OFF the deterministic quote fast-path ─────────────
// A side-effect verb means the user wants to mutate state (watchlist/portfolio/
// briefing), not read a price — must go through the LLM so the right write-tool runs.
const SIDE_EFFECT_VERB_RE =
  /\b(add|remove|delete|clear|track|follow|unwatch|unfollow|watchlist|watch|portfolio|owns?|holding?s?|hold|alert|briefing|buy|sell|purchase|bought|sold)\b/i;

// A request for non-quote data — let the LLM route to the correct data tool.
const OTHER_DATA_RE =
  /\b(news|history|historical|earnings?|filing|10-?k|10-?q|8-?k|analyst|rating|dividend|profile|forecast|fundamentals?|balance sheet|cash flow|income statement|sec)\b/i;

// A definitional/explainer ask — not a price lookup.
const EXPLAINER_RE =
  /\b(what (is|are|does|was)|explain|tell me about|who (is|are)|define|how does|describe)\b/i;

// A comparison ("BTC vs ETH", "compare AAPL and MSFT") is analytical, not a plain
// quote — defer to the LLM. Note: a bare "X and Y" is NOT a comparison; we quote both.
const COMPARE_RE = /\bvs\b|\bversus\b|\bcompare\b|\bcomparison\b/i;

// Conversational follow-up that reads as "give me the price of X" without any explicit
// quote word — "what about SOL", "how about LTC", "where BTC at".
const FOLLOWUP_RE = /\b(what|how)\s+about\b|\bwhere\b.*\bat\b/i;

const MAX_FAST_PATH_TICKERS = 5;

/**
 * Deterministically resolves EVERY ticker named in a clean price ask, so the caller can
 * call get_stock_quote for each and skip the decision LLM entirely. Returns [] the moment
 * the turn looks like anything else (a state change, a different data type, an explainer,
 * or a comparison), in which case the caller falls back to the LLM tool-routing path.
 *
 * This exists because the decision LLM (fast 8B) both (a) adds a full round-trip of
 * latency and (b) mis-picks the tool when recent history primes it — e.g. answering
 * "what about SOL and LTC?" with update_user_watchlist right after a watchlist add.
 * Handling multiple assets here is what stops two-coin queries from misfiring: naming
 * two assets used to bail to the LLM, which is exactly where the wrong tool got picked.
 */
export function extractQuoteTickers(text: string): string[] {
  if (!text) return [];
  const trimmed = text.trim();

  // Only side-effect write verbs (add/remove watchlist) skip quote fast-path
  if (SIDE_EFFECT_VERB_RE.test(trimmed)) {
    return [];
  }

  const upper = trimmed.toUpperCase();
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (sym: string | undefined) => {
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      found.push(sym);
    }
  };

  // 1. Explicit $TICKER (all of them).
  for (const m of upper.matchAll(/\$([A-Z]{1,6})\b/g)) push(m[1]);

  // 2. Full crypto names (BITCOIN → BTC).
  for (const [name, sym] of Object.entries(CRYPTO_NAME_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(upper)) push(sym);
  }

  // 3. Known crypto tokens (BTC, ETH, …). Normalize any "-USD" pair to its base.
  for (const tok of KNOWN_CRYPTO) {
    if (new RegExp(`\\b${tok.replace('-', '\\-')}\\b`).test(upper)) push(tok.replace('-USD', ''));
  }

  // 4. Ticker/index/commodity aliases — longest key first, and blank out each match so
  //    "BANK NIFTY" doesn't also register as "NIFTY".
  let masked = upper;
  for (const key of Object.keys(TICKER_ALIAS_MAP).sort((a, b) => b.length - a.length)) {
    if (masked.includes(key)) {
      push(TICKER_ALIAS_MAP[key]);
      masked = masked.split(key).join(' ');
    }
  }

  // 5. Lone caps-shaped tokens the USER typed (real tickers like NVDA, BTCUSD). Matched against
  //    the ORIGINAL text, never the uppercased copy — otherwise every ordinary word
  //    ("about", "price", "doing") would look like a ticker.
  for (const c of trimmed.match(/\b[A-Z]{2,7}\b/g) || []) {
    if (!TICKER_STOPWORDS.has(c)) push(c);
  }

  if (found.length === 0) return [];

  // Confirm it reads as a price ask, not incidental asset mentions. Any of:
  //  - explicit quote language ("price", "doing", "worth", …)
  //  - a "what/how about X" follow-up
  //  - the message is essentially just the tickers plus a word or two of filler
  //    (≤2 non-ticker words), e.g. "SOL and LTC", "solana ltc".
  const wordCount = trimmed.split(/\s+/).length;
  const isPriceAsk =
    QUOTE_INTENT_RE.test(trimmed) ||
    FOLLOWUP_RE.test(trimmed) ||
    wordCount - found.length <= 2;
  if (!isPriceAsk) return [];

  return found.slice(0, MAX_FAST_PATH_TICKERS);
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

  // Resolve index/commodity/market aliases (e.g. NIFTY -> ^NSEI, INDIA.SENSEX -> ^BSESN)
  if (TICKER_ALIAS_MAP[symbol]) {
    symbol = TICKER_ALIAS_MAP[symbol];
  } else {
    const aliasKeys = Object.keys(TICKER_ALIAS_MAP).sort((a, b) => b.length - a.length);
    for (const key of aliasKeys) {
      if (symbol.includes(key)) {
        symbol = TICKER_ALIAS_MAP[key];
        break;
      }
    }
  }

  let isCrypto = KNOWN_CRYPTO.has(symbol) || symbol.endsWith('-USD') || (symbol.endsWith('USD') && symbol.length <= 7);
  if (isCrypto) {
    const cleanBase = symbol.replace('-USD', '').replace(/USD$/, '');
    symbol = `${cleanBase}-USD`;
    isCrypto = true;
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
      timeout: 4000,
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
      await setCache(`quote:${symbol}`, res, 120);
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
  const fmt = (n: number) => (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toFixed(2));
  return (
    `*${q.ticker}* · ${cur}${fmt(q.price)} · ${dir} ${sign}${q.changePercent.toFixed(2)}% (${sign}${cur}${fmt(q.change)})\n` +
    `• **Day Range**: ${cur}${fmt(q.low)} – ${cur}${fmt(q.high)}\n` +
    `• **Prev Close**: ${cur}${fmt(q.previousClose)}`
  );
}
