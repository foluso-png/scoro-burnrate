import "server-only";
import { getRedis } from "./redis";

// ---------------------------------------------------------------------------
// Conversation state stored per Slack user in Upstash
// ---------------------------------------------------------------------------
const KEY_PREFIX = "conversation:";
const TTL_SECONDS = 43200; // 12 hours

export type ConversationStep =
  | "awaiting_events"    // fetching calendar events
  | "review_matches"     // user reviewing AI match proposals
  | "editing"            // user editing/correcting a match
  | "confirming"         // user confirming before write to Scoro
  | "complete";          // entries written, conversation finished

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  isInternal: boolean;
}

export interface DraftEntry {
  eventId: string;
  eventTitle: string;
  projectId: number | null;
  projectName: string | null;
  taskId: number | null;
  taskTitle: string | null;
  confidence: "high" | "medium" | "low";
  description: string;
  approved: boolean;
  scoroEntryId: number | null;  // set after cron write
  durationMinutes: number | null; // set for manual entries; calendar entries use event times
  startDatetime: string | null;   // ISO datetime; null for manual entries
  endDatetime: string | null;     // ISO datetime; null for manual entries
}

export interface PendingEntry {
  text: string;             // original user input
  durationMinutes: number;  // parsed duration
  projectId: number | null;
  projectName: string | null;
  clientName: string | null;
  taskId: number | null;
  taskTitle: string | null;
  confidence: "high" | "medium" | "low";
  description: string;
  isInternal: boolean;
}

export interface ConversationState {
  slackUserId: string;
  step: ConversationStep;
  events: CalendarEventSummary[];
  drafts: DraftEntry[];
  pendingEntry: PendingEntry | null; // set during confirming step
  slackChannelId: string | null;     // DM channel for follow-up messages
  messageTs: string | null;          // timestamp of the last bot message (for updates)
  createdAt: string;                 // ISO timestamp
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function key(slackUserId: string): string {
  return `${KEY_PREFIX}${slackUserId}`;
}

export async function saveConversation(state: ConversationState): Promise<void> {
  const redis = await getRedis();
  await redis.set(key(state.slackUserId), JSON.stringify(state), {
    ex: TTL_SECONDS,
  });
}

export async function loadConversation(
  slackUserId: string
): Promise<ConversationState | null> {
  const redis = await getRedis();
  const raw = await redis.get<string>(key(slackUserId));
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function clearConversation(slackUserId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(key(slackUserId));
}

/**
 * Create a fresh conversation state for a user.
 */
export function newConversation(
  slackUserId: string,
  events: CalendarEventSummary[] = []
): ConversationState {
  return {
    slackUserId,
    step: "awaiting_events",
    events,
    drafts: [],
    pendingEntry: null,
    slackChannelId: null,
    messageTs: null,
    createdAt: new Date().toISOString(),
  };
}
