import axios from 'axios';

const EDGAR_BASE = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_SUBMISSIONS = 'https://data.sec.gov/submissions';
const EDGAR_COMPANY_SEARCH = 'https://efts.sec.gov/LATEST/search-index?q=%22';

const HEADERS = {
  'User-Agent': 'Atlas Financial Assistant contact@atlas-ai.app',
  Accept: 'application/json',
};

// ─── Get company CIK from ticker ──────────────────────────────────────────────
const tickerToCIK: Record<string, string> = {};

export async function getCIK(ticker: string): Promise<string | null> {
  const sym = ticker.toUpperCase();
  if (tickerToCIK[sym]) return tickerToCIK[sym];

  try {
    const { data } = await axios.get(
      'https://www.sec.gov/files/company_tickers.json',
      { headers: HEADERS }
    );

    for (const entry of Object.values(data) as { cik_str: number; ticker: string; title: string }[]) {
      if (entry.ticker.toUpperCase() === sym) {
        const cik = String(entry.cik_str).padStart(10, '0');
        tickerToCIK[sym] = cik;
        return cik;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Get recent filings for a company ────────────────────────────────────────
export interface FilingItem {
  accessionNumber: string;
  filingDate: string;
  formType: string;
  primaryDocument: string;
  description?: string;
}

export async function getRecentFilings(
  ticker: string,
  formTypes: string[] = ['10-K', '10-Q', '8-K'],
  limit = 5
): Promise<FilingItem[]> {
  const cik = await getCIK(ticker);
  if (!cik) throw new Error(`Could not find CIK for ticker ${ticker}`);

  const { data } = await axios.get(`${EDGAR_SUBMISSIONS}/CIK${cik}.json`, {
    headers: HEADERS,
  });

  const filings = data.filings?.recent;
  if (!filings) return [];

  const results: FilingItem[] = [];
  const formTypeSet = new Set(formTypes);

  for (let i = 0; i < (filings.form?.length || 0) && results.length < limit; i++) {
    if (formTypeSet.has(filings.form[i])) {
      results.push({
        accessionNumber: filings.accessionNumber[i],
        filingDate: filings.filingDate[i],
        formType: filings.form[i],
        primaryDocument: filings.primaryDocument[i],
        description: filings.primaryDocDescription?.[i],
      });
    }
  }

  return results;
}

// ─── Full-text search across EDGAR filings ────────────────────────────────────
export interface FullTextResult {
  entityName: string;
  formType: string;
  filedAt: string;
  accessionNo: string;
  description?: string;
}

export async function searchFilings(
  query: string,
  formTypes: string[] = ['10-K', '10-Q', '8-K'],
  limit = 5
): Promise<FullTextResult[]> {
  const params = new URLSearchParams({
    q: `"${query}"`,
    dateRange: 'custom',
    startdt: new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0],
    enddt: new Date().toISOString().split('T')[0],
    forms: formTypes.join(','),
    hits: String(limit),
  });

  const { data } = await axios.get(
    `https://efts.sec.gov/LATEST/search-index?${params.toString()}`,
    { headers: HEADERS }
  );

  const hits = data?.hits?.hits || [];

  return hits.map(
    (h: {
      _source: {
        entity_name: string;
        file_date: string;
        form_type: string;
        accession_no: string;
        period_of_report: string;
      };
    }) => ({
      entityName: h._source.entity_name,
      formType: h._source.form_type,
      filedAt: h._source.file_date,
      accessionNo: h._source.accession_no,
      description: h._source.period_of_report,
    })
  );
}

// ─── Get filing text content for RAG / diff ──────────────────────────────────
export async function getFilingText(
  cik: string,
  accessionNumber: string,
  primaryDocument: string
): Promise<string> {
  const cleanAccession = accessionNumber.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${cleanAccession}/${primaryDocument}`;

  const { data } = await axios.get(url, {
    headers: { ...HEADERS, Accept: 'text/html' },
    timeout: 15000,
  });

  // Strip HTML tags for plain text
  return (data as string)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 50000); // cap at 50k chars
}

// Format filings for display
export function formatFilings(filings: FilingItem[], ticker: string): string {
  if (filings.length === 0) return `No recent filings found for ${ticker}.`;

  return (
    `Recent SEC filings for *${ticker.toUpperCase()}*:\n` +
    filings
      .map((f) => `- ${f.formType} · ${f.filingDate}${f.description ? ' — ' + f.description : ''}`)
      .join('\n')
  );
}
