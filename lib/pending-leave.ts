import "server-only";
import { getRedis } from "./redis";

const KEY_PREFIX = "pending_leave:";
const TTL_SECONDS = 3600; // 1 hour

export interface PendingLeave {
  slackUserId: string;
  scoroUserId: number;
  dates: string[]; // YYYY-MM-DD, weekdays only
  startLabel: string; // human-readable label for the range
}

function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

export async function savePendingLeave(leave: PendingLeave): Promise<void> {
  const redis = await getRedis();
  await redis.set(key(leave.slackUserId), JSON.stringify(leave), {
    ex: TTL_SECONDS,
  });
}

export async function loadPendingLeave(
  slackUserId: string
): Promise<PendingLeave | null> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function clearPendingLeave(slackUserId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(key(slackUserId));
}
