import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Write log: per-user hash of { YYYY-MM-DD: count } tracking how many
// Co-pilot entries were written to Scoro each day.
// ---------------------------------------------------------------------------

const HASH_PREFIX = "write_log:";
const APPROVED_PREFIX = "last_approved:";
const PRUNE_DAYS = 90;

function hashKey(slackId: string): string {
  return `${HASH_PREFIX}${slackId}`;
}

function approvedKey(slackId: string): string {
  return `${APPROVED_PREFIX}${slackId}`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Record successful writes for a user. Non-throwing: logs errors and returns.
 */
export async function recordWrites(
  slackId: string,
  count: number
): Promise<void> {
  if (count <= 0) return;

  try {
    const redis = await getRedis();
    const key = hashKey(slackId);
    const date = todayStr();

    await redis.hincrby(key, date, count);
    await redis.set(approvedKey(slackId), new Date().toISOString());

    // Prune fields older than 90 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PRUNE_DAYS);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    const allFields = await redis.hkeys(key);
    const stale = allFields.filter((f) => f < cutoffStr);
    if (stale.length > 0) {
      await redis.hdel(key, ...stale);
    }
  } catch (err) {
    console.error(
      `[write-log] Failed to record ${count} writes for ${slackId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Read usage stats for the admin page.
 * Returns { count7d, lastApproved } or null if no data exists.
 */
export async function readUsage(
  slackId: string
): Promise<{ count7d: number; lastApproved: string | null } | null> {
  try {
    const redis = await getRedis();
    const key = hashKey(slackId);

    const allFields = await redis.hgetall<Record<string, string>>(key);
    if (!allFields || Object.keys(allFields).length === 0) return null;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;

    let count7d = 0;
    for (const [date, val] of Object.entries(allFields)) {
      if (date >= cutoffStr) {
        count7d += parseInt(String(val), 10) || 0;
      }
    }

    const lastApproved = await redis.get<string>(approvedKey(slackId));

    return { count7d, lastApproved: lastApproved || null };
  } catch (err) {
    console.error(
      `[write-log] Failed to read usage for ${slackId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logged dates: per-user set of entry dates (YYYY-MM-DD) that have been
// approved and written to Scoro. Used by "log my week" to skip days.
// ---------------------------------------------------------------------------

const LOGGED_DATES_PREFIX = "logged_dates:";
const LOGGED_DATES_TTL = 60 * 86400; // 60 days

export async function recordLoggedDate(
  slackId: string,
  dateStr: string
): Promise<void> {
  try {
    const redis = await getRedis();
    const key = `${LOGGED_DATES_PREFIX}${slackId}`;
    await redis.sadd(key, dateStr);
    await redis.expire(key, LOGGED_DATES_TTL);
  } catch (err) {
    console.error(
      `[write-log] Failed to record logged date ${dateStr} for ${slackId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function getLoggedDates(
  slackId: string
): Promise<Set<string>> {
  try {
    const redis = await getRedis();
    const members = await redis.smembers(`${LOGGED_DATES_PREFIX}${slackId}`);
    return new Set(members);
  } catch (err) {
    console.error(
      `[write-log] Failed to read logged dates for ${slackId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return new Set();
  }
}

/**
 * Return weekdays (Mon-Fri) from this Monday to today in London time,
 * excluding any dates already in the user's logged_dates set.
 */
export async function getRemainingWeekdays(
  slackId: string
): Promise<Array<{ date: Date; dateStr: string; isToday: boolean }>> {
  const nowLondon = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const dayOfWeek = nowLondon.getDay(); // 0=Sun, 1=Mon...5=Fri, 6=Sat

  // On weekends, cover Mon-Fri of the week just finished.
  // On weekdays, cover Mon through today inclusive.
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const lastDay = isWeekend ? 5 : dayOfWeek; // Friday (5) on weekends
  const mondayOffset = isWeekend
    ? dayOfWeek === 0 ? -6 : -(dayOfWeek - 1)  // Sun: 6 days back, Sat: 5 days back
    : -(dayOfWeek - 1);

  const logged = await getLoggedDates(slackId);
  const days: Array<{ date: Date; dateStr: string; isToday: boolean }> = [];

  for (let i = 0; i < lastDay; i++) {
    const d = new Date(nowLondon);
    d.setDate(nowLondon.getDate() + mondayOffset + i);
    d.setHours(0, 0, 0, 0);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!logged.has(dateStr)) {
      // "today" is never true on weekends since we're covering past weekdays
      const isTodayEntry = !isWeekend && i === lastDay - 1;
      days.push({ date: new Date(d), dateStr, isToday: isTodayEntry });
    }
  }

  return days;
}
