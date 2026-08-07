import { ToolDefinition } from './llm';
import { getQuote, formatQuote } from '../tools/stockQuote';
import { getCompanyProfile, getBasicFinancials, getInsiderTransactions } from '../tools/companyProfile';
import { getEarningsCalendar, getSurprises, formatEarningsEvent } from '../tools/earnings';
import { getCompanyNews, getMarketNews, getAnalystRatings, getPriceTarget, formatNewsItems } from '../tools/news';
import { getRecentFilings, searchFilings, formatFilings, getCIK } from '../tools/secFilings';
import { getDailyPrices, summarizePerformance } from '../tools/alphaVantage';
import { quickLookup, getHistoricalReturn } from '../tools/yahooFinance';
import { IUserProfile } from '../models/UserProfile';

// ─── Tool definitions for Groq function-calling ────────────────────────────────
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_stock_quote',
    description: 'Get current real-time stock or cryptocurrency price and trading data for a ticker symbol (e.g. AAPL, TSLA, BTC, ETH, SOL, Bitcoin). ALWAYS call this tool when user asks for prices, quotes, or market status of any stock or crypto token.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol or crypto token code/name (e.g. AAPL, TSLA, BTC, ETH, SOL, BITCOIN)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_company_profile',
    description: 'Get company overview, business description, industry, market cap, and key financial ratios. Use when user asks about a company, what it does, or fundamental data.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        include_financials: { type: 'string', description: 'Set to "true" to include financial ratios like P/E, margins', enum: ['true', 'false'] },
        include_insider: { type: 'string', description: 'Set to "true" to include recent insider transactions', enum: ['true', 'false'] },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_earnings_calendar',
    description: 'Get upcoming earnings dates for followed tickers or specific companies. Use when user asks when a company reports earnings.',
    parameters: {
      type: 'object',
      properties: {
        tickers: { type: 'string', description: 'Comma-separated ticker symbols, or empty for general calendar' },
        days_ahead: { type: 'string', description: 'Number of days ahead to look (default: 30)' },
      },
      required: [],
    },
  },
  {
    name: 'get_earnings_history',
    description: 'Get recent earnings history and EPS surprises for a company. Use when user asks how a company has performed in recent quarters.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_company_news',
    description: 'Get recent news articles about a specific company. Use when user asks for news, what happened to a stock, or recent developments.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        days: { type: 'string', description: 'Number of days to look back (default: 3, max: 7)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_market_news',
    description: 'Get general market news and macro headlines. Use when user asks about the market overall, macro events, or general financial news.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'News category', enum: ['general', 'forex', 'crypto', 'merger'] },
      },
      required: [],
    },
  },
  {
    name: 'get_analyst_ratings',
    description: 'Get analyst consensus ratings and price targets for a stock.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        include_price_target: { type: 'string', description: 'Set to "true" to include analyst price targets', enum: ['true', 'false'] },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_sec_filings',
    description: 'Get recent SEC filings (10-K, 10-Q, 8-K, Form 4) for a company from EDGAR. Use when user asks about regulatory filings, annual/quarterly reports, or insider transactions in SEC context.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        form_types: { type: 'string', description: 'Comma-separated form types (default: 10-K,10-Q,8-K)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'search_sec_filings',
    description: 'Full-text search across all SEC EDGAR filings for a specific topic or phrase. Use for research into regulatory language, risk factors across companies, or finding companies that disclosed a specific issue.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query phrase' },
        form_types: { type: 'string', description: 'Comma-separated form types to search (default: 10-K,10-Q)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_price_history',
    description: 'Get historical price performance for a stock. Use when user asks about returns over a period, how a stock has trended, or historical context.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        period: { type: 'string', description: 'Time period', enum: ['1mo', '3mo', '6mo', '1y', '2y'] },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'update_user_watchlist',
    description: 'Add or remove tickers from the user\'s watchlist. Use when user says they want to follow a stock, track it, or stop tracking it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['add', 'remove'] },
        tickers: { type: 'string', description: 'Comma-separated ticker symbols' },
        alert_threshold: { type: 'string', description: 'Alert on price move greater than this % (e.g. "5" for 5%)' },
      },
      required: ['action', 'tickers'],
    },
  },
  {
    name: 'update_user_portfolio',
    description: 'Update the user\'s portfolio holdings when they tell you what they own. Use when user mentions owning shares or asks about their portfolio.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action', enum: ['add', 'remove', 'clear'] },
        holdings: { type: 'string', description: 'JSON array of holdings, e.g. [{"ticker":"AAPL","shares":50},{"ticker":"TSLA","shares":20}]' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_briefing_preference',
    description: 'Set when the user wants their daily market briefing. Use when user mentions a preferred time for updates.',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'Time in HH:MM format (e.g. "08:00")' },
        enabled: { type: 'string', description: '"true" to enable, "false" to disable', enum: ['true', 'false'] },
        timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'update_user_profile',
    description: 'Update user profile information extracted from the conversation — role, sectors, insight preferences. Use during onboarding or when user shares preferences.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'User role', enum: ['investor', 'analyst', 'founder', 'student', 'finance_professional', 'other'] },
        sectors: { type: 'string', description: 'Comma-separated sectors of interest (e.g. "Technology,Healthcare,Energy")' },
        insight_preferences: { type: 'string', description: 'Comma-separated preferences: market_news,earnings,filings,analyst_ratings,macro' },
        onboarding_complete: { type: 'string', description: 'Set to "true" when onboarding is done', enum: ['true', 'false'] },
      },
      required: [],
    },
  },
];

// ─── Tool executor ─────────────────────────────────────────────────────────────
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  profile: IUserProfile | null,
  telegramId: number,
  onProfileUpdate: (updates: Partial<IUserProfile>) => Promise<void>
): Promise<string> {
  try {
    switch (toolName) {
      case 'get_stock_quote': {
        const q = await getQuote(args.ticker as string);
        return formatQuote(q);
      }

      case 'get_company_profile': {
        const ticker = args.ticker as string;
        const profile = await getCompanyProfile(ticker);
        let result = `*${profile.name}* (${profile.ticker})\n`;
        result += `Industry: ${profile.industry} · Exchange: ${profile.exchange}\n`;
        result += `Market Cap: $${(profile.marketCap / 1000).toFixed(1)}B · IPO: ${profile.ipo || 'N/A'}\n`;

        if (args.include_financials === 'true') {
          const fin = await getBasicFinancials(ticker);
          result += `\nKey metrics:\n`;
          result += `- P/E (TTM): ${fin.peRatio}\n- P/B: ${fin.pbRatio}\n`;
          result += `- Gross Margin: ${fin.grossMarginTTM}%\n- Net Margin: ${fin.netProfitMarginTTM}%\n`;
          result += `- 52W High: $${fin.week52High} · Low: $${fin.week52Low}`;
        }

        if (args.include_insider === 'true') {
          const insider = await getInsiderTransactions(ticker);
          result += `\n\nRecent insider transactions:\n${insider}`;
        }

        return result;
      }

      case 'get_earnings_calendar': {
        const tickers = args.tickers
          ? (args.tickers as string).split(',').map((t) => t.trim()).filter(Boolean)
          : profile?.watchlist?.map((w) => w.ticker) || [];
        const daysAhead = parseInt((args.days_ahead as string) || '30');
        const events = await getEarningsCalendar(tickers, daysAhead);
        if (events.length === 0) return 'No upcoming earnings in the next ' + daysAhead + ' days for the tracked tickers.';
        return 'Upcoming earnings:\n' + events.map(formatEarningsEvent).join('\n');
      }

      case 'get_earnings_history': {
        return await getSurprises(args.ticker as string);
      }

      case 'get_company_news': {
        const days = parseInt((args.days as string) || '3');
        const news = await getCompanyNews(args.ticker as string, days);
        return formatNewsItems(news, 5);
      }

      case 'get_market_news': {
        const news = await getMarketNews((args.category as 'general' | 'forex' | 'crypto' | 'merger') || 'general');
        return formatNewsItems(news, 5);
      }

      case 'get_analyst_ratings': {
        const ratings = await getAnalystRatings(args.ticker as string);
        if (args.include_price_target === 'true') {
          const target = await getPriceTarget(args.ticker as string);
          return ratings + '\n\n' + target;
        }
        return ratings;
      }

      case 'get_sec_filings': {
        const formTypes = (args.form_types as string)?.split(',').map((t) => t.trim()) || ['10-K', '10-Q', '8-K'];
        const filings = await getRecentFilings(args.ticker as string, formTypes);
        return formatFilings(filings, args.ticker as string);
      }

      case 'search_sec_filings': {
        const formTypes = (args.form_types as string)?.split(',').map((t) => t.trim()) || ['10-K', '10-Q'];
        const results = await searchFilings(args.query as string, formTypes);
        if (results.length === 0) return `No EDGAR filings found matching "${args.query}".`;
        return (
          `SEC filing search results for "${args.query}":\n` +
          results
            .map((r) => `- *${r.entityName}* · ${r.formType} · Filed: ${r.filedAt}`)
            .join('\n')
        );
      }

      case 'get_price_history': {
        const period = (args.period as '1mo' | '3mo' | '6mo' | '1y' | '2y') || '1y';
        try {
          return await getHistoricalReturn(args.ticker as string, period);
        } catch {
          // Fallback to Alpha Vantage
          const bars = await getDailyPrices(args.ticker as string);
          return summarizePerformance(bars);
        }
      }

      case 'update_user_watchlist': {
        const tickers = (args.tickers as string).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
        const action = args.action as 'add' | 'remove';
        const threshold = args.alert_threshold ? parseFloat(args.alert_threshold as string) : 5;

        if (action === 'add') {
          const existing = new Set((profile?.watchlist || []).map((w) => w.ticker));
          const newItems = tickers
            .filter((t) => !existing.has(t))
            .map((t) => ({ ticker: t, alertThreshold: threshold }));
          await onProfileUpdate({
            watchlist: [...(profile?.watchlist || []), ...newItems],
          } as Partial<IUserProfile>);
          return `Added ${tickers.join(', ')} to your watchlist. I'll alert you on moves > ${threshold}%.`;
        } else {
          const updated = (profile?.watchlist || []).filter((w) => !tickers.includes(w.ticker));
          await onProfileUpdate({ watchlist: updated } as Partial<IUserProfile>);
          return `Removed ${tickers.join(', ')} from your watchlist.`;
        }
      }

      case 'update_user_portfolio': {
        const action = args.action as 'add' | 'remove' | 'clear';
        if (action === 'clear') {
          await onProfileUpdate({ portfolio: [] } as Partial<IUserProfile>);
          return 'Portfolio cleared.';
        }

        const holdingsInput = args.holdings as string;
        if (!holdingsInput) return 'No holdings provided.';

        const holdings = JSON.parse(holdingsInput) as { ticker: string; shares: number; costBasis?: number }[];

        if (action === 'add') {
          const existingMap = new Map((profile?.portfolio || []).map((h) => [h.ticker, h]));
          for (const h of holdings) {
            existingMap.set(h.ticker.toUpperCase(), {
              ticker: h.ticker.toUpperCase(),
              shares: h.shares,
              costBasis: h.costBasis,
              assetType: 'stock',
            });
          }
          await onProfileUpdate({ portfolio: Array.from(existingMap.values()) } as Partial<IUserProfile>);
          return `Portfolio updated: ${holdings.map((h) => `${h.shares} ${h.ticker.toUpperCase()}`).join(', ')}.`;
        } else {
          const tickers = holdings.map((h) => h.ticker.toUpperCase());
          const updated = (profile?.portfolio || []).filter((h) => !tickers.includes(h.ticker));
          await onProfileUpdate({ portfolio: updated } as Partial<IUserProfile>);
          return `Removed ${tickers.join(', ')} from portfolio.`;
        }
      }

      case 'set_briefing_preference': {
        const updates: Partial<IUserProfile> = {};
        if (args.enabled === 'true') updates.briefingEnabled = true;
        if (args.enabled === 'false') updates.briefingEnabled = false;
        if (args.time) updates.briefingTime = args.time as string;
        if (args.timezone) updates.briefingTimezone = args.timezone as string;
        await onProfileUpdate(updates);
        return args.enabled === 'true'
          ? `Daily briefing scheduled for ${args.time || profile?.briefingTime || '08:00'} ${args.timezone || profile?.briefingTimezone || 'ET'}.`
          : 'Daily briefing disabled.';
      }

      case 'update_user_profile': {
        const updates: Partial<IUserProfile> = {};
        if (args.role) updates.role = args.role as IUserProfile['role'];
        if (args.sectors) updates.sectors = (args.sectors as string).split(',').map((s) => s.trim());
        if (args.insight_preferences) {
          updates.insightPreferences = (args.insight_preferences as string)
            .split(',')
            .map((p) => p.trim()) as IUserProfile['insightPreferences'];
        }
        if (args.onboarding_complete === 'true') updates.onboardingComplete = true;
        await onProfileUpdate(updates);
        return 'Profile updated.';
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    console.error(`[Tool] ${toolName} failed:`, (err as Error).message);
    return `Tool error (${toolName}): ${(err as Error).message}`;
  }
}
