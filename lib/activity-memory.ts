import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Per-user memory of confirmed activity types, keyed on project + task.
// When a user picks or confirms an activity type for a project/task combo,
// we remember it so future entries auto-select that activity.
// ---------------------------------------------------------------------------
const KEY_PREFIX = "activity_memory:";
const TTL_SECONDS = 7776000; // 90 days

export interface ActivityMapping {
  activity_id: number;
  activity_name: string;
  confirmed_at: string;
}

/** Map of "{projectId}:{taskId}" → confirmed activity. */
export type ActivityMemory = Record<string, ActivityMapping>;

function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

function compositeKey(projectId: number, taskId: number): string {
  return `${projectId}:${taskId}`;
}

export async function loadActivityMemory(
  slackUserId: string
): Promise<ActivityMemory> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function saveActivityMapping(
  slackUserId: string,
  projectId: number,
  taskId: number,
  activityId: number,
  activityName: string
): Promise<void> {
  const memory = await loadActivityMemory(slackUserId);

  memory[compositeKey(projectId, taskId)] = {
    activity_id: activityId,
    activity_name: activityName,
    confirmed_at: new Date().toISOString(),
  };

  const redis = await getRedis();
  await redis.set(key(slackUserId), JSON.stringify(memory), {
    ex: TTL_SECONDS,
  });
}

export async function deleteActivityMapping(
  slackUserId: string,
  projectId: number,
  taskId: number
): Promise<boolean> {
  const memory = await loadActivityMemory(slackUserId);
  const ck = compositeKey(projectId, taskId);
  if (!(ck in memory)) return false;

  delete memory[ck];

  const redis = await getRedis();
  if (Object.keys(memory).length === 0) {
    await redis.del(key(slackUserId));
  } else {
    await redis.set(key(slackUserId), JSON.stringify(memory), {
      ex: TTL_SECONDS,
    });
  }
  return true;
}
