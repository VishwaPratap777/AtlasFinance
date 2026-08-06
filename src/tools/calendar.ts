import { google, calendar_v3 } from 'googleapis';
import { IUserProfile } from '../models/UserProfile';
import { chat } from '../orchestrator/llm';

function getCalendarClient(profile: IUserProfile): calendar_v3.Calendar {
  if (!profile.googleTokens) throw new Error('Google Calendar not connected');

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

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  description?: string;
  location?: string;
}

export async function getUpcomingEvents(
  profile: IUserProfile,
  days = 7
): Promise<CalendarEvent[]> {
  const calendar = getCalendarClient(profile);

  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86400000).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  });

  const events = response.data.items || [];

  return events.map((e) => ({
    id: e.id || '',
    summary: e.summary || 'Untitled event',
    start: e.start?.dateTime || e.start?.date || '',
    end: e.end?.dateTime || e.end?.date || '',
    attendees: (e.attendees || [])
      .map((a) => a.displayName || a.email || '')
      .filter(Boolean),
    description: e.description?.substring(0, 200),
    location: e.location ?? undefined,
  }));
}

// ─── Meeting Prep Autopilot ───────────────────────────────────────────────────
export async function generateMeetingPrep(
  event: CalendarEvent,
  externalCompany: string
): Promise<string | null> {
  if (!externalCompany) return null;

  // Import financial data tools lazily
  const { getCompanyNews } = await import('./news');
  const { getCompanyProfile } = await import('./companyProfile');
  const { getRecentFilings } = await import('./secFilings');

  const [newsRes, profileRes, filingsRes] = await Promise.allSettled([
    getCompanyNews(externalCompany, 7),
    getCompanyProfile(externalCompany),
    getRecentFilings(externalCompany, ['8-K', '10-Q'], 2),
  ]);

  const dataParts: string[] = [];

  if (profileRes.status === 'fulfilled') {
    dataParts.push(`Company: ${profileRes.value.name} (${profileRes.value.industry}), Market Cap: $${(profileRes.value.marketCap / 1000).toFixed(1)}B`);
  }

  if (newsRes.status === 'fulfilled' && newsRes.value.length > 0) {
    dataParts.push(
      'Recent news:\n' +
        newsRes.value
          .slice(0, 3)
          .map((n) => `- ${n.headline}`)
          .join('\n')
    );
  }

  if (filingsRes.status === 'fulfilled' && filingsRes.value.length > 0) {
    dataParts.push(
      'Recent filings: ' +
        filingsRes.value.map((f) => `${f.formType} (${f.filingDate})`).join(', ')
    );
  }

  if (dataParts.length === 0) return null;

  const messages = [
    {
      role: 'system' as const,
      content: `You are Atlas. Write a very concise meeting prep brief (3-4 bullet points max) for a meeting with ${externalCompany}. Focus only on what the user needs to know walking into this meeting — recent performance, key news, any risks or opportunities. No fluff.`,
    },
    {
      role: 'user' as const,
      content: `Meeting: "${event.summary}" at ${event.start}\n\nData:\n${dataParts.join('\n\n')}`,
    },
  ];

  try {
    const response = await chat(messages);
    return `📋 *Meeting Prep: ${event.summary}*\n\n${response.content}`;
  } catch {
    return null;
  }
}

// ─── Check upcoming calendar for external company meetings ───────────────────
export async function checkForMeetingPrep(
  profile: IUserProfile,
  watchedCompanies: string[]
): Promise<{ event: CalendarEvent; company: string }[]> {
  if (!profile.googleConnected) return [];

  try {
    const events = await getUpcomingEvents(profile, 1); // next 24h

    const matches: { event: CalendarEvent; company: string }[] = [];

    for (const event of events) {
      for (const company of watchedCompanies) {
        const companyLower = company.toLowerCase();
        const eventText = `${event.summary} ${event.description || ''}`.toLowerCase();
        if (eventText.includes(companyLower)) {
          matches.push({ event, company });
          break;
        }
      }
    }

    return matches;
  } catch {
    return [];
  }
}
