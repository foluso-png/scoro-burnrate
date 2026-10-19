import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Per-user memory of confirmed phase picks.
// Keyed by project + task title + month so the pick is only valid for one
// calendar month. Next month the user is asked again.
// ---------------------------------------------------------------------------
const KEY_PREFIX = "phase_pick:";
const TTL_SECONDS = 7776000; // 90 days

export interface PhasePick {
  task_id: number;
  phase_id: number;
  phase_name: string;
  confirmed_at: string;
}

/** Map of "<projectId>:<taskTitle>:<YYYY-MM>" → confirmed pick. */
export type PhaseMemory = Record<string, PhasePick>;

function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

export function phaseMemoryKey(
  projectId: number,
  taskTitle: string,
  entryDate: string
): string {
  const month = entryDate.slice(0, 7); // "YYYY-MM"
  return `${projectId}:${taskTitle}:${month}`;
}

export async function loadPhaseMemory(
  slackUserId: string
): Promise<PhaseMemory> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function savePhaseMapping(
  slackUserId: string,
  projectId: number,
  taskTitle: string,
  entryDate: string,
  taskId: number,
  phaseId: number,
  phaseName: string
): Promise<void> {
  const memory = await loadPhaseMemory(slackUserId);
  const memKey = phaseMemoryKey(projectId, taskTitle, entryDate);

  memory[memKey] = {
    task_id: taskId,
    phase_id: phaseId,
    phase_name: phaseName,
    confirmed_at: new Date().toISOString(),
  };

  const redis = await getRedis();
  await redis.set(key(slackUserId), JSON.stringify(memory), {
    ex: TTL_SECONDS,
  });
}
