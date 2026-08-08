import axios from 'axios';
import { env } from '../config/env';
import { getCache, setCache } from '../config/redis';

const BASE = 'https://finnhub.io/api/v1';
const headers = () => ({ 'X-Finnhub-Token': env.FINNHUB_API_KEY });

export interface CompanyProfile {
  ticker: string;
  name: string;
  industry: string;
  sector?: string;
  country: string;
  exchange: string;
  marketCap: number;
  shareOutstanding: number;
  logo?: string;
  weburl?: string;
  description?: string;
  ipo?: string;
  currency: string;
}

export async function getCompanyProfile(ticker: string): Promise<CompanyProfile> {
  const symbol = ticker.toUpperCase();
  const cached = await getCache<CompanyProfile>(`profile:${symbol}`);
  if (cached) return cached;

  const [profileRes] = await Promise.allSettled([
    axios.get(`${BASE}/stock/profile2`, { params: { symbol }, headers: headers(), timeout: 4000 }),
  ]);

  const profile = profileRes.status === 'fulfilled' ? profileRes.value.data : {};

  if (!profile || !profile.name) {
    throw new Error(`No company profile found for ${symbol}`);
  }

  const result: CompanyProfile = {
    ticker: symbol,
    name: profile.name,
    industry: profile.finnhubIndustry || 'Unknown',
    country: profile.country || 'US',
    exchange: profile.exchange || '',
    marketCap: profile.marketCapitalization || 0,
    shareOutstanding: profile.shareOutstanding || 0,
    logo: profile.logo,
    weburl: profile.weburl,
    ipo: profile.ipo,
    currency: profile.currency || 'USD',
  };

  await setCache(`profile:${symbol}`, result, 86400); // 24 hour TTL
  return result;
}

export async function getBasicFinancials(ticker: string): Promise<Record<string, number | string>> {
  const symbol = ticker.toUpperCase();
  const cached = await getCache<Record<string, number | string>>(`financials:${symbol}`);
  if (cached) return cached;

  const { data } = await axios.get(`${BASE}/stock/metric`, {
    params: { symbol, metric: 'all' },
    headers: headers(),
    timeout: 4000,
  });

  const m = data?.metric || {};

  const result = {
    peRatio: m['peBasicExclExtraTTM'] || m['peTTM'] || 'N/A',
    pbRatio: m['pb'] || 'N/A',
    epsGrowthTTMYoY: m['epsGrowthTTMYoy'] || 'N/A',
    revenueGrowthTTMYoY: m['revenueGrowthTTMYoy'] || 'N/A',
    grossMarginTTM: m['grossMarginTTM'] || 'N/A',
    netProfitMarginTTM: m['netProfitMarginTTM'] || 'N/A',
    dividendYieldIndicatedAnnual: m['dividendYieldIndicatedAnnual'] || 'N/A',
    week52High: m['52WeekHigh'] || 'N/A',
    week52Low: m['52WeekLow'] || 'N/A',
    betaMonthly: m['beta'] || 'N/A',
  };

  await setCache(`financials:${symbol}`, result, 43200); // 12 hour TTL
  return result;
}

export async function getInsiderTransactions(ticker: string): Promise<string> {
  const symbol = ticker.toUpperCase();
  const cached = await getCache<string>(`insider:${symbol}`);
  if (cached) return cached;

  const from = new Date();
  from.setMonth(from.getMonth() - 3);
  const fromStr = from.toISOString().split('T')[0];

  const { data } = await axios.get(`${BASE}/stock/insider-transactions`, {
    params: { symbol, from: fromStr },
    headers: headers(),
    timeout: 4000,
  });

  const txns = data?.data?.slice(0, 5) || [];
  let result = 'No insider transactions in the past 3 months.';
  if (txns.length > 0) {
    result = txns
      .map(
        (t: { name: string; transactionType: string; share: number; transactionDate: string }) =>
          `- ${t.name}: ${t.transactionType} ${t.share.toLocaleString()} shares (${t.transactionDate})`
      )
      .join('\n');
  }

  await setCache(`insider:${symbol}`, result, 3600); // 1 hour TTL
  return result;
}

