import "server-only";
import { scoroPost } from "./matcher";
import type { ConversationState, DraftEntry } from "./conversation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COPILOT_TAG = "[Co-pilot]";
const COPILOT_DRAFT_TAG = "[Co-pilot draft]";
const SCORO_USER_ID = 107; // TEMP: Foluso's Scoro user ID, hardcoded for single-user

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ScoroTimeEntry {
  time_entry_id: number;
  id?: number;
  description?: string;
  project_id?: number;
  event_id?: number; // task ID in Scoro
  duration?: string; // "HH:MM:SS"
  start_datetime?: string;
  end_datetime?: string;
  [key: string]: unknown;
}

export interface WriteResultItem {
  eventTitle: string;
  projectName: string | null;
  durationMinutes: number;
  action: "created" | "updated" | "skipped";
  scoroEntryId: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function durationToStr(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function parseScoroDuration(dur: string): number {
  // "HH:MM:SS" → minutes
  const parts = dur.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function isCopilotEntry(description: string | undefined): boolean {
  if (!description) return false;
  return description.includes(COPILOT_TAG) || description.includes(COPILOT_DRAFT_TAG);
}

// ---------------------------------------------------------------------------
// Fetch today's co-pilot entries for the user
// ---------------------------------------------------------------------------
async function fetchTodayCopilotEntries(): Promise<ScoroTimeEntry[]> {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const allEntries: ScoroTimeEntry[] = [];
  let page = 1;

  while (true) {
    const res = await scoroPost<ScoroTimeEntry[]>("/timeEntries/list", {
      filter: {
        user_id: SCORO_USER_ID,
        start_date: dateStr,
        end_date: dateStr,
      },
      per_page: 100,
      page,
    });
    const entries = Array.isArray(res.data) ? res.data : [];
    allEntries.push(...entries);
    if (entries.length < 100) break;
    page++;
  }

  return allEntries.filter((e) => isCopilotEntry(e.description));
}

// ---------------------------------------------------------------------------
// Write or update a single entry
// ---------------------------------------------------------------------------
async function writeOrUpdateEntry(
  draft: DraftEntry,
  existingEntries: ScoroTimeEntry[]
): Promise<WriteResultItem> {
  if (!draft.approved || draft.projectId === null || draft.taskId === null) {
    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: draft.durationMinutes || 0,
      action: "skipped",
      scoroEntryId: null,
      error: null,
    };
  }

  const durationMins = draft.durationMinutes || 0;
  if (durationMins <= 0) {
    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: 0,
      action: "skipped",
      scoroEntryId: null,
      error: "no duration",
    };
  }

  // Match-and-update: find an existing co-pilot entry for the same task
  // Only match on task ID (event_id in Scoro) to avoid false matches
  const existing = existingEntries.find(
    (e) => e.event_id === draft.taskId && isCopilotEntry(e.description)
  );

  try {
    if (existing) {
      // Update existing entry: add duration, update description and tag
      const existingMins = existing.duration ? parseScoroDuration(existing.duration) : 0;
      const totalMins = existingMins + durationMins;

      const entryId = existing.time_entry_id || existing.id!;
      const description = `${COPILOT_TAG} ${draft.description}`;

      await scoroPost(`/timeEntries/modify/${entryId}`, {
        request: {
          duration: durationToStr(totalMins),
          description,
          is_completed: true,
        },
      });

      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: totalMins,
        action: "updated",
        scoroEntryId: entryId,
        error: null,
      };
    }

    // If this draft was already written by the cron (has a scoroEntryId),
    // update it in place rather than creating a duplicate
    if (draft.scoroEntryId) {
      const description = `${COPILOT_TAG} ${draft.description}`;

      await scoroPost(`/timeEntries/modify/${draft.scoroEntryId}`, {
        request: {
          description,
          is_completed: true,
        },
      });

      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: durationMins,
        action: "updated",
        scoroEntryId: draft.scoroEntryId,
        error: null,
      };
    }

    // Create new entry
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const description = `${COPILOT_TAG} ${draft.description}`;

    // For manual entries without specific times, use 09:00 as start
    const startDatetime = draft.startDatetime || `${dateStr}T09:00:00`;
    const endMs = new Date(startDatetime).getTime() + durationMins * 60000;
    const endDatetime = draft.endDatetime || new Date(endMs).toISOString();

    const res = await scoroPost<Record<string, unknown>>("/timeEntries/modify", {
      request: {
        event_id: draft.taskId,
        user_id: SCORO_USER_ID,
        start_datetime: startDatetime,
        end_datetime: endDatetime,
        duration: durationToStr(durationMins),
        description,
        is_completed: true,
      },
    });

    const entryId =
      (res.data.time_entry_id as number) || (res.data.id as number);

    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: durationMins,
      action: "created",
      scoroEntryId: entryId,
      error: null,
    };
  } catch (err) {
    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: durationMins,
      action: "created",
      scoroEntryId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Finalise conversation — write all approved drafts to Scoro
// ---------------------------------------------------------------------------
export async function finaliseAndWrite(
  convo: ConversationState
): Promise<WriteResultItem[]> {
  const approvedDrafts = convo.drafts.filter(
    (d) => d.approved && d.projectId !== null && d.taskId !== null
  );

  if (approvedDrafts.length === 0) {
    return [];
  }

  // Fetch existing co-pilot entries for match-and-update
  const existingEntries = await fetchTodayCopilotEntries();

  const results: WriteResultItem[] = [];
  for (const draft of approvedDrafts) {
    const result = await writeOrUpdateEntry(draft, existingEntries);
    results.push(result);

    // If we created/updated an entry, add it to the "existing" list so
    // subsequent drafts for the same task will match-and-update against it
    if (result.scoroEntryId && result.action !== "skipped") {
      existingEntries.push({
        time_entry_id: result.scoroEntryId,
        event_id: draft.taskId!,
        description: `${COPILOT_TAG} ${draft.description}`,
        duration: durationToStr(result.durationMinutes),
      });
    }
  }

  return results;
}
