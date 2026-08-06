import { google, gmail_v1 } from 'googleapis';
import { IUserProfile } from '../models/UserProfile';

function getGmailClient(profile: IUserProfile): gmail_v1.Gmail {
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

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function searchGmailThreads(
  profile: IUserProfile,
  query: string,
  maxResults = 5
): Promise<{ subject: string; from: string; snippet: string; date: string }[]> {
  const gmail = getGmailClient(profile);

  const threadList = await gmail.users.threads.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const threads = threadList.data.threads || [];
  const results: { subject: string; from: string; snippet: string; date: string }[] = [];

  for (const thread of threads.slice(0, maxResults)) {
    if (!thread.id) continue;
    const detail = await gmail.users.threads.get({
      userId: 'me',
      id: thread.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });

    const messages = detail.data.messages || [];
    if (messages.length === 0) continue;

    const firstMessage = messages[0];
    const headers = firstMessage.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    results.push({
      subject: getHeader('Subject'),
      from: getHeader('From'),
      snippet: firstMessage.snippet || '',
      date: getHeader('Date'),
    });
  }

  return results;
}

export async function summarizeGmailContext(
  profile: IUserProfile,
  companyOrTopic: string
): Promise<string> {
  if (!profile.googleConnected) {
    return 'Gmail is not connected. To connect, just ask me "connect my Gmail".';
  }

  try {
    const threads = await searchGmailThreads(profile, companyOrTopic, 5);
    if (threads.length === 0) {
      return `No recent emails found related to "${companyOrTopic}".`;
    }

    return (
      `Recent emails about *${companyOrTopic}*:\n` +
      threads
        .map(
          (t) =>
            `- *${t.subject}*\n  From: ${t.from}\n  "${t.snippet.substring(0, 100)}..."`
        )
        .join('\n\n')
    );
  } catch (err) {
    return `Could not access Gmail: ${(err as Error).message}`;
  }
}
