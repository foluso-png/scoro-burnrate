import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Per-user preferences stored in Upstash
// ---------------------------------------------------------------------------
const KEY_PREFIX = "user_prefs:";

export interface UserPrefs {
  /** Preferred delivery hour in Europe/London time (0-23). Default: 17 (5 pm). */
  deliveryHour: number;
  /** If true, skip this user in the daily cron loop. */
  paused: boolean;
}

const DEFAULT_PREFS: UserPrefs = {
  deliveryHour: 17,
  paused: false,
};

function key(slackId: string): string {
  return `${KEY_PREFIX}${slackId}`;
}

export async function loadUserPrefs(slackId: string): Promise<UserPrefs> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackId));
  if (!raw) return { ...DEFAULT_PREFS };
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { ...DEFAULT_PREFS, ...parsed };
}

export async function saveUserPrefs(
  slackId: string,
  prefs: UserPrefs
): Promise<void> {
  const redis = await getRedis();
  await redis.set(key(slackId), JSON.stringify(prefs));
}
