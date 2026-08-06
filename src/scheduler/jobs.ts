import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { UserProfile } from '../models/UserProfile';
import { generateMorningBrief, checkWatchlistAlerts, checkFilingDiff } from './briefing';
import { getEarningsCalendar } from '../tools/earnings';

// ─── Main scheduler init ──────────────────────────────────────────────────────
export function initScheduler(bot: Telegraf): void {
  console.log('[Scheduler] Initializing background jobs...');

  // ── Morning briefs: check every 5 minutes, deliver at user's set time ──────
  cron.schedule('*/5 * * * *', async () => {
    await runMorningBriefs(bot);
  });

  // ── Watchlist price alerts: every 30 minutes during market hours (ET) ──────
  // Mon-Fri, 9:30am-4pm ET → run every 30 min 13:30-21:00 UTC
  cron.schedule('*/30 13-21 * * 1-5', async () => {
    await runWatchlistAlerts(bot);
  });

  // ── Earnings alerts: daily at 7am ET (11am UTC) ────────────────────────────
  cron.schedule('0 11 * * 1-5', async () => {
    await runEarningsAlerts(bot);
  });

  // ── Filing check: daily at 6pm ET (10pm UTC) — after market close ──────────
  cron.schedule('0 22 * * 1-5', async () => {
    await runFilingAlerts(bot);
  });

  console.log('[Scheduler] Jobs initialized ✓');
}

// ─── Morning brief delivery ───────────────────────────────────────────────────
async function runMorningBriefs(bot: Telegraf): Promise<void> {
  try {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();

    // Find users who want a brief at this approximate time
    const users = await UserProfile.find({
      briefingEnabled: true,
      watchlist: { $exists: true, $ne: [] },
    });

    for (const user of users) {
      try {
        // Convert user's preferred time to UTC for comparison
        const [prefHour, prefMinute] = (user.briefingTime || '08:00').split(':').map(Number);

        // Simple timezone offset lookup (production would use proper TZ library)
        const tzOffset = getTimezoneOffset(user.briefingTimezone || 'America/New_York');
        const targetUtcHour = (prefHour - tzOffset + 24) % 24;

        // Check if it's time to send (within 5-minute window)
        const minuteDiff = Math.abs(utcHour * 60 + utcMinute - targetUtcHour * 60 - prefMinute);
        if (minuteDiff > 5) continue;

        // Skip if already sent today
        if (user.lastBriefSentAt) {
          const lastSent = new Date(user.lastBriefSentAt);
          if (
            lastSent.toDateString() === now.toDateString()
          ) continue;
        }

        const brief = await generateMorningBrief(user.telegramId);
        if (!brief) continue;

        try {
          await bot.telegram.sendMessage(
            user.telegramId,
            `☀️ *Morning Brief*\n\n${brief}`,
            { parse_mode: 'Markdown' }
          );
          await UserProfile.updateOne(
            { telegramId: user.telegramId },
            { $set: { lastBriefSentAt: now } }
          );
        } catch (sendErr) {
          console.warn(`[Scheduler] Failed to send brief to ${user.telegramId}:`, (sendErr as Error).message);
        }
      } catch (userErr) {
        console.error(`[Scheduler] Error processing user ${user.telegramId}:`, (userErr as Error).message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Morning brief error:', err);
  }
}

// ─── Watchlist price alerts ───────────────────────────────────────────────────
async function runWatchlistAlerts(bot: Telegraf): Promise<void> {
  try {
    const users = await UserProfile.find({
      watchlist: { $exists: true, $ne: [] },
    });

    for (const user of users) {
      try {
        const alerts = await checkWatchlistAlerts(user.telegramId);
        if (alerts.length === 0) continue;

        const message =
          `🚨 *Watchlist Alert*\n\n` +
          alerts
            .map((a) => {
              const dir = a.changePercent > 0 ? '▲' : '▼';
              return `*${a.ticker}* ${dir} ${Math.abs(a.changePercent).toFixed(1)}% → $${a.price.toFixed(2)}`;
            })
            .join('\n');

        await bot.telegram.sendMessage(user.telegramId, message, {
          parse_mode: 'Markdown',
        });
      } catch { /* ignore per-user errors */ }
    }
  } catch (err) {
    console.error('[Scheduler] Watchlist alert error:', err);
  }
}

// ─── Earnings 24h-ahead alerts ───────────────────────────────────────────────
async function runEarningsAlerts(bot: Telegraf): Promise<void> {
  try {
    const users = await UserProfile.find({
      'insightPreferences': 'earnings',
      watchlist: { $exists: true, $ne: [] },
    });

    for (const user of users) {
      try {
        const tickers = user.watchlist.map((w) => w.ticker);
        const events = await getEarningsCalendar(tickers, 2); // next 2 days

        // Filter to events happening tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        const upcoming = events.filter((e) => e.date === tomorrowStr);
        if (upcoming.length === 0) continue;

        const message =
          `📅 *Earnings Tomorrow*\n\n` +
          upcoming
            .map((e) => {
              const timing = e.hour === 'bmo' ? 'Before market open' : e.hour === 'amc' ? 'After close' : '';
              const eps = e.epsEstimate != null ? ` · EPS est: $${e.epsEstimate.toFixed(2)}` : '';
              return `*${e.symbol}* — ${timing}${eps}`;
            })
            .join('\n');

        await bot.telegram.sendMessage(user.telegramId, message, {
          parse_mode: 'Markdown',
        });
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.error('[Scheduler] Earnings alert error:', err);
  }
}

// ─── Filing change alerts ─────────────────────────────────────────────────────
async function runFilingAlerts(bot: Telegraf): Promise<void> {
  try {
    const users = await UserProfile.find({
      'insightPreferences': 'filings',
      watchlist: { $exists: true, $ne: [] },
    });

    for (const user of users) {
      // Only check top 3 watchlist tickers to avoid rate limits
      for (const item of user.watchlist.slice(0, 3)) {
        try {
          await checkFilingDiff(item.ticker, bot, user.telegramId);
          // Small delay between checks
          await new Promise((r) => setTimeout(r, 2000));
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('[Scheduler] Filing alert error:', err);
  }
}

// ─── Simple timezone offset helper ───────────────────────────────────────────
function getTimezoneOffset(tz: string): number {
  const offsets: Record<string, number> = {
    'America/New_York': 5,
    'America/Chicago': 6,
    'America/Denver': 7,
    'America/Los_Angeles': 8,
    'America/Phoenix': 7,
    'Europe/London': 0,
    'Europe/Paris': -1,
    'Europe/Berlin': -1,
    'Asia/Tokyo': -9,
    'Asia/Shanghai': -8,
    'Asia/Singapore': -8,
    'Asia/Mumbai': -5.5,
    'Australia/Sydney': -10,
  };
  return offsets[tz] ?? 5; // default ET
}
