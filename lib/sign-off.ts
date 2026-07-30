import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Rotating sign-off messages appended to daily Slack summaries
// ---------------------------------------------------------------------------
const KEY_PREFIX = "last_signoff:";

const BASE_POOL = [
  "That's you sorted for today. Try not to think about Scoro again until tomorrow.",
  "All logged. Go be a person now.",
  "Nice work today, the spreadsheet gods are pleased.",
  "That's a wrap. Feet up, phone down.",
  "Timesheet's sorted, the rest of the evening's legally yours.",
  "Solid day. Even better evening, hopefully.",
  "Done and dusted. Go outside, apparently it exists.",
  "That's today wrapped. You survived, mostly.",
];

const BIG_DAY_POOL = [
  "That was a proper shift. Switch off, doctor's orders (I'm not a doctor).",
  "Big day. You've officially earned the right to ignore Slack tonight.",
  "That's a lot of hours. Go home, you're basically a Scoro entry yourself now.",
  "Good graft today. Even your keyboard needs a rest.",
  "Full day logged. Treat yourself to something that isn't a spreadsheet.",
];

const BIG_DAY_THRESHOLD_HOURS = 7;

function key(slackId: string): string {
  return `${KEY_PREFIX}${slackId}`;
}

function pickRandom(pool: string[], exclude?: string): string {
  const candidates = exclude
    ? pool.filter((m) => m !== exclude)
    : pool;
  // If filtering removed everything (pool of 1), fall back to full pool
  const list = candidates.length > 0 ? candidates : pool;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Pick a sign-off message for a user, avoiding the one they saw last time.
 * Persists the chosen message so the next call can exclude it.
 *
 * @param totalMinutes  Total logged minutes for the day (used for big-day bonus line)
 */
export async function pickSignOff(
  slackId: string,
  totalMinutes: number
): Promise<string> {
  const redis = await getRedis();
  const lastShown = await redis.get<string>(key(slackId));

  const base = pickRandom(BASE_POOL, lastShown ?? undefined);

  // Persist the base message we chose (not the bonus)
  await redis.set(key(slackId), base);

  const totalHours = totalMinutes / 60;
  if (totalHours > BIG_DAY_THRESHOLD_HOURS) {
    const bonus = pickRandom(BIG_DAY_POOL);
    return `${base}\n\n${bonus}`;
  }

  return base;
}
