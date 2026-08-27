import "server-only";
import { scoroPost, toNaiveLondon } from "./matcher";
import type { ConversationState, DraftEntry } from "./conversation";
import { assertCanWrite } from "./demo-gate";
import { PhaseCache, resolveTaskForPhase } from "./scoro-phases";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const COPILOT_TAG = "[Co-pilot]";
const COPILOT_DRAFT_TAG = "[Co-pilot draft]";

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
  action: "created" | "updated" | "skipped" | "skipped_demo" | "failed" | "blocked_phase";
  scoroEntryId: number | null;
  resolvedTaskId: number | null;
  error: string | null;
  phaseWarning: string | null;
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

/** Strip the [Co-pilot] or [Co-pilot draft] prefix to get the raw description body. */
function copilotDescriptionBody(description: string): string {
  return description
    .replace(COPILOT_DRAFT_TAG, "")
    .replace(COPILOT_TAG, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch today's co-pilot entries for the user
// ---------------------------------------------------------------------------
async function fetchTodayCopilotEntries(scoroUserId: number): Promise<ScoroTimeEntry[]> {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const allEntries: ScoroTimeEntry[] = [];
  let page = 1;

  while (true) {
    const res = await scoroPost<ScoroTimeEntry[]>("/timeEntries/list", {
      filter: {
        user_id: scoroUserId,
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
// Read-back verification — confirm an entry actually exists after write
// ---------------------------------------------------------------------------
async function verifyEntryExists(entryId: number): Promise<boolean> {
  try {
    const res = await scoroPost<Record<string, unknown>>(
      `/timeEntries/view/${entryId}`,
      {}
    );
    const id = (res.data.time_entry_id as number) || (res.data.id as number);
    return id === entryId;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write or update a single entry
// ---------------------------------------------------------------------------
async function writeOrUpdateEntry(
  draft: DraftEntry,
  existingEntries: ScoroTimeEntry[],
  scoroUserId: number,
  phaseCache: PhaseCache
): Promise<WriteResultItem> {
  if (!draft.approved || draft.projectId === null || draft.taskId === null) {
    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: draft.durationMinutes || 0,
      action: "skipped",
      scoroEntryId: null,
      resolvedTaskId: null,
      error: null,
      phaseWarning: null,
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
      resolvedTaskId: draft.taskId,
      error: "no duration",
      phaseWarning: null,
    };
  }

  // Phase resolution: determine the correct task for the entry date
  let resolvedTaskId = draft.taskId;
  let phaseWarning: string | null = null;

  const entryDate = draft.startDatetime || new Date().toISOString();
  try {
    const phaseData = await phaseCache.get(draft.projectId);
    const resolution = resolveTaskForPhase(
      draft.taskId,
      draft.taskTitle || "",
      phaseData.tasks,
      phaseData.phases,
      entryDate
    );

    resolvedTaskId = resolution.taskId;
    phaseWarning = resolution.warning;

    if (resolution.blocked) {
      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: durationMins,
        action: "blocked_phase",
        scoroEntryId: null,
        resolvedTaskId,
        error: resolution.warning,
        phaseWarning: resolution.warning,
      };
    }

    if (resolution.swapped) {
      console.log(
        `[phase] Swapped task for "${draft.eventTitle}": ${draft.taskId} → ${resolution.taskId} (${resolution.taskTitle})`
      );
    }
  } catch (err) {
    // Phase fetch failed — log and proceed without phase resolution
    // rather than silently treating the project as unphased
    console.error(
      `[phase] Failed to fetch phase data for project ${draft.projectId}: ${err instanceof Error ? err.message : String(err)}`
    );
    phaseWarning = "Could not verify phase — phase data fetch failed. Entry logged to the matched task.";
  }

  // Match-and-update: find an existing co-pilot entry for the same task
  // Match against the resolved task ID (may have been swapped for phase)
  const existing = existingEntries.find(
    (e) => e.event_id === resolvedTaskId && isCopilotEntry(e.description)
  );

  try {
    if (existing) {
      // Same event rewritten (e.g. lunch run then 6pm run) → SET duration.
      // Different event on the same task (e.g. two separate meetings) → ADD duration.
      const existingBody = copilotDescriptionBody(existing.description || "");
      const isSameEvent = existingBody === draft.description.trim();

      const existingMins = existing.duration ? parseScoroDuration(existing.duration) : 0;
      const totalMins = isSameEvent ? durationMins : existingMins + durationMins;

      const entryId = existing.time_entry_id || existing.id!;
      const description = `${COPILOT_TAG} ${draft.description}`;

      await scoroPost(`/timeEntries/modify/${entryId}`, {
        request: {
          duration: durationToStr(totalMins),
          description,
          is_completed: true,
        },
      });

      // Read-back verification
      const verified = await verifyEntryExists(entryId);
      if (!verified) {
        return {
          eventTitle: draft.eventTitle,
          projectName: draft.projectName,
          durationMinutes: totalMins,
          action: "failed",
          scoroEntryId: null,
          error: "Scoro accepted the update but the entry could not be verified afterwards",
          resolvedTaskId,
          phaseWarning,
        };
      }

      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: totalMins,
        action: "updated",
        scoroEntryId: entryId,
        resolvedTaskId,
        error: null,
        phaseWarning,
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

      // Read-back verification
      const verified = await verifyEntryExists(draft.scoroEntryId);
      if (!verified) {
        return {
          eventTitle: draft.eventTitle,
          projectName: draft.projectName,
          durationMinutes: durationMins,
          action: "failed",
          scoroEntryId: null,
          error: "Scoro accepted the update but the entry could not be verified afterwards",
          resolvedTaskId,
          phaseWarning,
        };
      }

      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: durationMins,
        action: "updated",
        scoroEntryId: draft.scoroEntryId,
        resolvedTaskId,
        error: null,
        phaseWarning,
      };
    }

    // Create new entry
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const description = `${COPILOT_TAG} ${draft.description}`;

    // For manual entries without specific times, use 09:00 as start
    const rawStart = draft.startDatetime || `${dateStr}T09:00:00`;
    const startDatetime = toNaiveLondon(rawStart);
    const rawEnd = draft.endDatetime;
    let endDatetime: string;
    if (rawEnd) {
      endDatetime = toNaiveLondon(rawEnd);
    } else {
      // Compute end by adding duration to the naive start (no UTC round-trip)
      const [datePart, timePart] = startDatetime.split("T");
      const [hh, mm, ss] = timePart.split(":").map(Number);
      const totalMins = hh * 60 + mm + durationMins;
      const endH = Math.floor(totalMins / 60) % 24;
      const endM = totalMins % 60;
      endDatetime = `${datePart}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:${String(ss || 0).padStart(2, "0")}`;
    }

    const res = await scoroPost<Record<string, unknown>>("/timeEntries/modify", {
      request: {
        event_id: resolvedTaskId,
        user_id: scoroUserId,
        start_datetime: startDatetime,
        end_datetime: endDatetime,
        duration: durationToStr(durationMins),
        description,
        is_completed: true,
      },
    });

    const entryId =
      (res.data.time_entry_id as number) || (res.data.id as number);

    // Read-back verification
    const verified = await verifyEntryExists(entryId);
    if (!verified) {
      return {
        eventTitle: draft.eventTitle,
        projectName: draft.projectName,
        durationMinutes: durationMins,
        action: "failed",
        scoroEntryId: null,
        error: "Scoro accepted the write but the entry could not be verified afterwards",
        resolvedTaskId,
        phaseWarning,
      };
    }

    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: durationMins,
      action: "created",
      scoroEntryId: entryId,
      resolvedTaskId,
      error: null,
      phaseWarning,
    };
  } catch (err) {
    return {
      eventTitle: draft.eventTitle,
      projectName: draft.projectName,
      durationMinutes: durationMins,
      action: "failed",
      scoroEntryId: null,
      error: err instanceof Error ? err.message : String(err),
      resolvedTaskId,
      phaseWarning,
    };
  }
}

// ---------------------------------------------------------------------------
// Update an existing Scoro entry in place (used by the "Fix" flow)
// ---------------------------------------------------------------------------
export async function updateExistingEntry(
  slackUserId: string,
  entryId: number,
  updates: {
    taskId?: number;
    projectId?: number;
    durationMinutes?: number;
    description?: string;
  }
): Promise<void> {
  await assertCanWrite(slackUserId);

  const payload: Record<string, unknown> = {};

  if (updates.taskId !== undefined) payload.event_id = updates.taskId;
  if (updates.description !== undefined) payload.description = `${COPILOT_TAG} ${updates.description}`;
  if (updates.durationMinutes !== undefined) payload.duration = durationToStr(updates.durationMinutes);

  await scoroPost(`/timeEntries/modify/${entryId}`, { request: payload });
}

// ---------------------------------------------------------------------------
// Finalise conversation — write all approved drafts to Scoro
// ---------------------------------------------------------------------------
export async function finaliseAndWrite(
  convo: ConversationState,
  scoroUserId: number
): Promise<WriteResultItem[]> {
  await assertCanWrite(convo.slackUserId);

  const approvedDrafts = convo.drafts.filter(
    (d) => d.approved && d.projectId !== null && d.taskId !== null
  );

  if (approvedDrafts.length === 0) {
    return [];
  }

  // Fetch existing co-pilot entries for match-and-update
  const existingEntries = await fetchTodayCopilotEntries(scoroUserId);

  // Phase cache: one fetch per project per batch
  const phaseCache = new PhaseCache();

  const results: WriteResultItem[] = [];
  for (const draft of approvedDrafts) {
    const result = await writeOrUpdateEntry(draft, existingEntries, scoroUserId, phaseCache);
    results.push(result);

    // If we created/updated an entry, add it to the "existing" list so
    // subsequent drafts for the same task will match-and-update against it
    if (result.scoroEntryId && result.action !== "skipped" && result.action !== "skipped_demo" && result.action !== "failed") {
      existingEntries.push({
        time_entry_id: result.scoroEntryId,
        event_id: result.resolvedTaskId ?? draft.taskId!,
        description: `${COPILOT_TAG} ${draft.description}`,
        duration: durationToStr(result.durationMinutes),
      });
    }
  }

  return results;
}
