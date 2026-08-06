import { google } from 'googleapis';
import { IUserProfile } from '../models/UserProfile';
import { chat } from '../orchestrator/llm';

function getAuth(profile: IUserProfile) {
  if (!profile.googleTokens) throw new Error('Google not connected');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: profile.googleTokens.accessToken,
    refresh_token: profile.googleTokens.refreshToken,
    expiry_date: profile.googleTokens.expiryDate,
  });

  return oauth2Client;
}

// ─── Analyze a Google Sheets spreadsheet ─────────────────────────────────────
export async function analyzeGoogleSheet(
  profile: IUserProfile,
  spreadsheetIdOrUrl: string,
  userQuestion: string
): Promise<string> {
  const auth = getAuth(profile);
  const sheets = google.sheets({ version: 'v4', auth });

  // Extract spreadsheet ID from URL if needed
  const spreadsheetId = spreadsheetIdOrUrl.includes('docs.google.com')
    ? spreadsheetIdOrUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || spreadsheetIdOrUrl
    : spreadsheetIdOrUrl;

  try {
    // Get all sheets metadata
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetNames = meta.data.sheets?.map((s) => s.properties?.title || '') || [];

    // Read first sheet (or all small ones)
    const ranges = sheetNames.slice(0, 3).map((name) => `'${name}'!A1:Z100`);

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
    });

    const allData: string[] = [];
    for (const range of response.data.valueRanges || []) {
      const values = range.values || [];
      const sheetText = values
        .slice(0, 50)
        .map((row) => row.join('\t'))
        .join('\n');
      allData.push(sheetText);
    }

    const dataText = allData.join('\n\n---\n\n').substring(0, 6000);

    const messages = [
      {
        role: 'system' as const,
        content:
          'You are Atlas, a financial analyst assistant. Analyze the spreadsheet data and answer the user\'s question concisely and insightfully. Focus on financial insights, anomalies, and what the numbers mean.',
      },
      {
        role: 'user' as const,
        content: `Spreadsheet data:\n${dataText}\n\nQuestion: ${userQuestion}`,
      },
    ];

    const result = await chat(messages);
    return result.content;
  } catch (err) {
    return `Could not analyze spreadsheet: ${(err as Error).message}`;
  }
}

// ─── List recent Drive files ───────────────────────────────────────────────────
export async function listRecentDriveFiles(
  profile: IUserProfile,
  query = '',
  limit = 10
): Promise<{ name: string; id: string; mimeType: string; modifiedTime: string }[]> {
  const auth = getAuth(profile);
  const drive = google.drive({ version: 'v3', auth });

  const q = query
    ? `name contains '${query}' and trashed = false`
    : 'trashed = false';

  const response = await drive.files.list({
    q,
    pageSize: limit,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime)',
  });

  return (response.data.files || []).map((f) => ({
    name: f.name || '',
    id: f.id || '',
    mimeType: f.mimeType || '',
    modifiedTime: f.modifiedTime || '',
  }));
}

// ─── OAuth2 URL generator ─────────────────────────────────────────────────────
export function generateGoogleAuthUrl(): string {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ],
    prompt: 'consent',
  });
}

// ─── Exchange auth code for tokens ───────────────────────────────────────────
export async function exchangeGoogleCode(
  code: string
): Promise<{ accessToken: string; refreshToken: string; expiryDate?: number }> {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const { tokens } = await oauth2Client.getToken(code);

  return {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiryDate: tokens.expiry_date || undefined,
  };
}
