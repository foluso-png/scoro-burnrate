import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Per-user memory of confirmed event → project/task mappings.
// Recurring meetings (weekly RAGs, 1:1s) get remembered so they don't
// need re-matching every time.
// ---------------------------------------------------------------------------
const KEY_PREFIX = "event_memory:";
const TTL_SECONDS = 7776000; // 90 days

export interface EventMapping {
  project_id: number;
  project_name: string;
  task_id: number | null;
  task_title: string | null;
  confirmed_at: string;
}

export type EventMemory = Record<string, EventMapping>;

/**
 * Normalise a calendar event title for memory lookup.
 * Strips dates, day names, ordinals, and punctuation so that
 * "Weekly RAG meeting — 28 Jul" matches "Weekly RAG meeting".
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/g, "") // dates like 28/07/2026
    .replace(
      /\b(mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/gi,
      ""
    )
    .replace(/\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi, "")
    .replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, "") // ordinals and lone numbers
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

export async function loadEventMemory(
  slackUserId: string
): Promise<EventMemory> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function saveEventMapping(
  slackUserId: string,
  eventTitle: string,
  mapping: Omit<EventMapping, "confirmed_at">
): Promise<void> {
  const memory = await loadEventMemory(slackUserId);
  const normalised = normaliseTitle(eventTitle);
  if (!normalised) return;

  memory[normalised] = {
    ...mapping,
    confirmed_at: new Date().toISOString(),
  };

  const redis = await getRedis();
  await redis.set(key(slackUserId), JSON.stringify(memory), {
    ex: TTL_SECONDS,
  });
}

export async function lookupEventMapping(
  slackUserId: string,
  eventTitle: string
): Promise<EventMapping | null> {
  const memory = await loadEventMemory(slackUserId);
  const normalised = normaliseTitle(eventTitle);
  return memory[normalised] || null;
}

export async function deleteEventMappingsByProject(
  slackUserId: string,
  projectId: number
): Promise<string[]> {
  const memory = await loadEventMemory(slackUserId);
  const removed: string[] = [];

  for (const [key, mapping] of Object.entries(memory)) {
    if (mapping.project_id === projectId) {
      removed.push(key);
      delete memory[key];
    }
  }

  if (removed.length > 0) {
    const redis = await getRedis();
    if (Object.keys(memory).length === 0) {
      await redis.del(`${KEY_PREFIX}${slackUserId}`);
    } else {
      await redis.set(
        `${KEY_PREFIX}${slackUserId}`,
        JSON.stringify(memory),
        { ex: TTL_SECONDS }
      );
    }
  }

  return removed;
}
