import "server-only";
import { scoroPost } from "./matcher";

// ---------------------------------------------------------------------------
// Phase-aware task resolution
//
// Scoro assigns phases to TASKS, not time entries. A time entry inherits its
// phase from the task it is linked to. To log time on the correct phase, we
// must pick the task whose project_phase_id matches the phase covering the
// entry date.
// ---------------------------------------------------------------------------

// Set to true to block entries when no task exists on the correct phase.
// When false (default), entries are written to the matched task as-is with
// a warning in the Slack summary.
export const BLOCK_WRONG_PHASE = false;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ScoroPhase {
  id: number;
  project_id: number;
  title: string;
  start_date: string; // "YYYY-MM-DD"
  end_date: string;   // "YYYY-MM-DD"
}

export interface PhaseResolution {
  /** The task event_id to use (may differ from the originally matched task) */
  taskId: number;
  /** The task name (for display) */
  taskTitle: string;
  /** Whether the task was swapped to a sibling on the correct phase */
  swapped: boolean;
  /** True if the entry should not be written (only when BLOCK_WRONG_PHASE is on) */
  blocked: boolean;
  /** Warning message if the entry will land on the wrong phase */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Data fetching — phases and full task list for a project
// ---------------------------------------------------------------------------

interface PhaseTaskRecord {
  task_id: number;
  title: string;
  project_phase_id: number;
}

interface ScoroTaskRaw {
  event_id: number;
  event_name: string;
  is_completed: number;
  project_phase_id?: number;
  [key: string]: unknown;
}

export interface ProjectPhaseData {
  phases: ScoroPhase[];
  tasks: PhaseTaskRecord[];
}

/**
 * Fetch phases and the full (non-deduplicated) task list for a project.
 * Throws on API failure so callers can distinguish "unphased project"
 * (phases: []) from "fetch failed".
 */
async function fetchProjectPhaseData(projectId: number): Promise<ProjectPhaseData> {
  // Fetch phases from /projects/view (already includes phases array)
  const projRes = await scoroPost<Record<string, unknown>>(
    `/projects/view/${projectId}`,
    { detailed_response: true }
  );
  const rawPhases = (projRes.data.phases as Array<Record<string, unknown>>) || [];
  const phases: ScoroPhase[] = rawPhases.map((p) => ({
    id: p.id as number,
    project_id: projectId,
    title: String(p.title),
    start_date: String(p.start_date),
    end_date: String(p.end_date),
  }));

  // If no phases, skip the task fetch — no phase resolution needed
  if (phases.length === 0) {
    return { phases: [], tasks: [] };
  }

  // Fetch full task list (not deduplicated) to find phase siblings
  const allTasks: PhaseTaskRecord[] = [];
  let page = 1;
  while (true) {
    const res = await scoroPost<ScoroTaskRaw[]>("/tasks/list", {
      filter: { project_id: projectId },
      per_page: 100,
      page,
    });
    const tasks = Array.isArray(res.data) ? res.data : [];
    for (const t of tasks) {
      if (t.is_completed === 0) {
        allTasks.push({
          task_id: t.event_id,
          title: t.event_name || "Untitled",
          project_phase_id: t.project_phase_id ?? 0,
        });
      }
    }
    if (tasks.length < 100) break;
    page++;
  }

  return { phases, tasks: allTasks };
}

/**
 * Per-batch cache for project phase data. Create one at the start of a
 * write batch and pass it through. Avoids repeated API calls when
 * multiple entries target the same project.
 */
export class PhaseCache {
  private cache = new Map<number, ProjectPhaseData>();

  async get(projectId: number): Promise<ProjectPhaseData> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    // fetchProjectPhaseData throws on API failure — let it propagate
    const data = await fetchProjectPhaseData(projectId);
    this.cache.set(projectId, data);
    return data;
  }
}

// ---------------------------------------------------------------------------
// Phase resolution
// ---------------------------------------------------------------------------

/**
 * Find the phase covering a given date.
 * Returns null if no phase covers the date or the project has no phases.
 */
export function findPhaseForDate(
  phases: ScoroPhase[],
  dateStr: string
): ScoroPhase | null {
  if (phases.length === 0) return null;
  // dateStr is "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS..."
  const date = dateStr.slice(0, 10);
  return phases.find((p) => p.start_date <= date && date <= p.end_date) ?? null;
}

/**
 * Given the AI-matched task, check whether it's on the correct phase for the
 * entry date. If not, try to find a sibling task (same name) on the correct
 * phase.
 *
 * @param matchedTaskId  - the event_id picked by the AI matcher
 * @param matchedTaskTitle - the task name picked by the AI matcher
 * @param allTasks - all tasks on the project, each with project_phase_id
 * @param phases - the project's phase definitions (empty if unphased project)
 * @param entryDate - the entry's date (ISO string, uses first 10 chars)
 */
export function resolveTaskForPhase(
  matchedTaskId: number,
  matchedTaskTitle: string,
  allTasks: Array<{ task_id: number; title: string; project_phase_id: number }>,
  phases: ScoroPhase[],
  entryDate: string
): PhaseResolution {
  // No phases on this project — nothing to do
  if (phases.length === 0) {
    return { taskId: matchedTaskId, taskTitle: matchedTaskTitle, swapped: false, blocked: false, warning: null };
  }

  // Find the matched task's phase
  const matchedTask = allTasks.find((t) => t.task_id === matchedTaskId);
  if (!matchedTask) {
    // Task not in our list (shouldn't happen) — pass through
    return { taskId: matchedTaskId, taskTitle: matchedTaskTitle, swapped: false, blocked: false, warning: null };
  }

  // Unphased task (project_phase_id === 0) — leave it alone
  if (matchedTask.project_phase_id === 0) {
    return { taskId: matchedTaskId, taskTitle: matchedTaskTitle, swapped: false, blocked: false, warning: null };
  }

  // Find which phase covers the entry date
  const targetPhase = findPhaseForDate(phases, entryDate);
  if (!targetPhase) {
    // Entry date doesn't fall within any phase — warn but don't block
    const dateDisplay = entryDate.slice(0, 10);
    return {
      taskId: matchedTaskId,
      taskTitle: matchedTaskTitle,
      swapped: false,
      blocked: false,
      warning: `No phase covers ${dateDisplay} on this project. Entry logged to "${matchedTaskTitle}" on the matched phase.`,
    };
  }

  // Is the matched task already on the correct phase?
  if (matchedTask.project_phase_id === targetPhase.id) {
    return { taskId: matchedTaskId, taskTitle: matchedTaskTitle, swapped: false, blocked: false, warning: null };
  }

  // Wrong phase — try to find a sibling task with the same name on the target phase
  const sibling = allTasks.find(
    (t) =>
      t.project_phase_id === targetPhase.id &&
      t.title === matchedTaskTitle
  );

  if (sibling) {
    return {
      taskId: sibling.task_id,
      taskTitle: sibling.title,
      swapped: true,
      blocked: false,
      warning: null,
    };
  }

  // No sibling on the correct phase
  const wrongPhase = phases.find((p) => p.id === matchedTask.project_phase_id);
  const wrongPhaseName = wrongPhase?.title ?? `phase ${matchedTask.project_phase_id}`;

  if (BLOCK_WRONG_PHASE) {
    return {
      taskId: matchedTaskId,
      taskTitle: matchedTaskTitle,
      swapped: false,
      blocked: true,
      warning: `"${matchedTaskTitle}" has no task on the ${targetPhase.title} phase. Entry would land on ${wrongPhaseName}. Ask your PM to add tasks to ${targetPhase.title}.`,
    };
  }

  return {
    taskId: matchedTaskId,
    taskTitle: matchedTaskTitle,
    swapped: false,
    blocked: false,
    warning: `"${matchedTaskTitle}" landed on ${wrongPhaseName} instead of ${targetPhase.title}. No matching task exists on ${targetPhase.title} yet — ask your PM to create one.`,
  };
}
