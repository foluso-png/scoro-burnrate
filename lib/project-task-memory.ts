import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Per-user memory of confirmed project → task mappings.
// When a user picks a task for a project they haven't been matched to before,
// we remember it so future entries on the same project auto-select that task.
// ---------------------------------------------------------------------------
const KEY_PREFIX = "task_memory:";
const TTL_SECONDS = 7776000; // 90 days

export interface ProjectTaskMapping {
  task_id: number;
  task_title: string;
  confirmed_at: string;
}

/** Map of project ID (as string key) → confirmed task. */
export type ProjectTaskMemory = Record<string, ProjectTaskMapping>;

function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

export async function loadProjectTaskMemory(
  slackUserId: string
): Promise<ProjectTaskMemory> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function saveProjectTaskMapping(
  slackUserId: string,
  projectId: number,
  taskId: number,
  taskTitle: string
): Promise<void> {
  const memory = await loadProjectTaskMemory(slackUserId);

  memory[String(projectId)] = {
    task_id: taskId,
    task_title: taskTitle,
    confirmed_at: new Date().toISOString(),
  };

  const redis = await getRedis();
  await redis.set(key(slackUserId), JSON.stringify(memory), {
    ex: TTL_SECONDS,
  });
}

export async function deleteProjectTaskMapping(
  slackUserId: string,
  projectId: number
): Promise<boolean> {
  const memory = await loadProjectTaskMemory(slackUserId);
  const key_ = String(projectId);
  if (!(key_ in memory)) return false;

  delete memory[key_];

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
