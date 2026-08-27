import "server-only";
import { getAccessToken } from "./google-auth";
import {
  newConversation,
  saveConversation,
  CalendarEventSummary,
  DraftEntry,
} from "./conversation";
import {
  matchEvents,
  getProjectLookup,
  scoroPost,
  timeSlot,
  toNaiveLondon,
  MatchResult,
  ProjectRecord,
} from "./matcher";
import {
  loadEventMemory,
  normaliseTitle,
  EventMemory,
} from "./event-memory";
import { pickSignOff } from "./sign-off";
import { loadUserPrefs, saveUserPrefs, todayLondon, DEMO_BANNER } from "./user-prefs";
import { loadProjectTaskMemory } from "./project-task-memory";
import { assertCanWrite } from "./demo-gate";
import { PhaseCache, resolveTaskForPhase } from "./scoro-phases";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const COPILOT_TAG = "[Co-pilot draft]";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface GCalEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; self?: boolean }>;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  isInternal: boolean;
}

export interface WriteResult {
  event_id: string;
  event_title: string;
  project_name: string | null;
  task_title: string | null;
  confidence: string;
  scoro_entry_id: number | null;
  error: string | null;
  phaseWarning: string | null;
}

export interface SummaryResult {
  eventCount: number;
  matched: number;
  failed: number;
  skipped: number;
  slackStatus: string;
  written: WriteResult[];
  skippedEvents: {
    event_id: string;
    description: string;
    confidence: string;
    reason: string;
  }[];
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
function isInternalEmail(email: string): boolean {
  return (
    email.endsWith("@campfire.co.uk") ||
    email.endsWith("@resource.calendar.google.com")
  );
}

async function fetchDayEvents(
  accessToken: string,
  cutoff: Date,
  targetDate?: Date
): Promise<CalendarEvent[]> {
  const dayRef = targetDate || cutoff;
  const startOfDay = new Date(
    dayRef.getFullYear(),
    dayRef.getMonth(),
    dayRef.getDate()
  );
  // For past dates, fetch the full day; for today, only up to now
  const endBound = targetDate
    ? new Date(startOfDay.getTime() + 86400000) // start of next day
    : cutoff;

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endBound.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const items: GCalEvent[] = data.items || [];

  return items
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e, i) => {
      const otherAttendees = (e.attendees || [])
        .filter((a) => !a.self)
        .map((a) => a.email);

      const isInternal =
        otherAttendees.length === 0 || otherAttendees.every(isInternalEmail);

      return {
        id: `ev-${i + 1}`,
        title: e.summary || "(no title)",
        start: e.start!.dateTime!,
        end: e.end!.dateTime!,
        attendees: otherAttendees,
        isInternal,
      };
    });
}

// ---------------------------------------------------------------------------
// Scoro draft writing
// ---------------------------------------------------------------------------
function durationStr(startISO: string, endISO: string): string {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  const totalMins = Math.round(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

async function writeDraftsToScoro(
  slackUserId: string,
  events: CalendarEvent[],
  matches: MatchResult[],
  scoroUserId: number
): Promise<{ written: WriteResult[]; skipped: MatchResult[] }> {
  await assertCanWrite(slackUserId);

  const approved = matches.filter(
    (m) =>
      m.is_trackable !== false &&
      m.project_id !== null &&
      m.task_id !== null &&
      (m.confidence === "high" || m.confidence === "medium")
  );
  const skipped = matches.filter(
    (m) =>
      m.is_trackable === false ||
      m.project_id === null ||
      m.task_id === null ||
      m.confidence === "low"
  );

  const phaseCache = new PhaseCache();
  const written: WriteResult[] = [];

  for (const match of approved) {
    const event = events.find((e) => e.id === match.event_id);
    if (!event) continue;

    // Phase resolution: pick the task on the correct phase for the entry date
    let resolvedTaskId = match.task_id!;
    let phaseWarning: string | null = null;

    try {
      const phaseData = await phaseCache.get(match.project_id!);
      const resolution = resolveTaskForPhase(
        match.task_id!,
        match.task_title || "",
        phaseData.tasks,
        phaseData.phases,
        event.start
      );
      resolvedTaskId = resolution.taskId;
      phaseWarning = resolution.warning;

      if (resolution.blocked) {
        written.push({
          event_id: match.event_id,
          event_title: event.title,
          project_name: match.project_name,
          task_title: match.task_title,
          confidence: match.confidence,
          scoro_entry_id: null,
          error: resolution.warning,
          phaseWarning: resolution.warning,
        });
        continue;
      }

      if (resolution.swapped) {
        console.log(
          `[phase] Draft: swapped task for "${event.title}": ${match.task_id} → ${resolution.taskId} (${resolution.taskTitle})`
        );
      }
    } catch (err) {
      console.error(
        `[phase] Draft: failed to fetch phase data for project ${match.project_id}: ${err instanceof Error ? err.message : String(err)}`
      );
      phaseWarning = "Could not verify phase — phase data fetch failed. Entry logged to the matched task.";
    }

    const description = `${COPILOT_TAG} ${match.description}`;

    const payload: Record<string, unknown> = {
      event_id: resolvedTaskId,
      user_id: scoroUserId,
      start_datetime: toNaiveLondon(event.start),
      end_datetime: toNaiveLondon(event.end),
      duration: durationStr(event.start, event.end),
      description,
      is_completed: false,
    };

    try {
      const res = await scoroPost<Record<string, unknown>>(
        "/timeEntries/modify",
        { request: payload }
      );
      const entryId =
        (res.data.time_entry_id as number) || (res.data.id as number);
      written.push({
        event_id: match.event_id,
        event_title: event.title,
        project_name: match.project_name,
        task_title: match.task_title,
        confidence: match.confidence,
        scoro_entry_id: entryId,
        error: null,
        phaseWarning,
      });
    } catch (err) {
      written.push({
        event_id: match.event_id,
        event_title: event.title,
        project_name: match.project_name,
        task_title: match.task_title,
        confidence: match.confidence,
        scoro_entry_id: null,
        error: err instanceof Error ? err.message : String(err),
        phaseWarning,
      });
    }
  }

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Slack message formatting
// ---------------------------------------------------------------------------
export function buildSummaryActionButtons(): Record<string, unknown> {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "\u2705 Looks right", emoji: true },
        action_id: "looks_right",
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "\u2795 Add time", emoji: true },
        action_id: "add_time",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "\u270f\ufe0f Fix an entry",
          emoji: true,
        },
        action_id: "fix_entry",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "\ud83d\udcdd Log my day",
          emoji: true,
        },
        action_id: "wrap_up",
      },
    ],
  };
}

function buildTaskDropdownOptions(
  project: ProjectRecord,
  suggestedTaskId: number | null
): {
  options: Array<{ text: { type: string; text: string }; value: string }>;
  initialOption: { text: { type: string; text: string }; value: string } | null;
} {
  if (project.tasks.length <= 1) return { options: [], initialOption: null };

  const options = project.tasks.map((t) => ({
    text: { type: "plain_text" as const, text: t.title.slice(0, 75) },
    value: String(t.task_id),
  }));

  const initialOption = suggestedTaskId
    ? options.find((o) => o.value === String(suggestedTaskId)) || null
    : null;

  return { options, initialOption };
}

function formatSlackBlocks(
  events: CalendarEvent[],
  written: WriteResult[],
  skipped: MatchResult[],
  matches: MatchResult[],
  didWrite: boolean,
  activeProjects: ProjectRecord[],
  rememberedIds: Set<string>,
  dateLabel?: string
): { text: string; blocks: Record<string, unknown>[] } {
  const today = dateLabel || new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Build display lines from write results (if we wrote) or matches (if we didn't)
  const approvedMatches = matches.filter(
    (m) =>
      m.project_id !== null &&
      m.task_id !== null &&
      m.confidence !== "low"
  );
  const successfulWrites = written.filter((w) => !w.error);
  const displayItems = didWrite ? successfulWrites : [];
  const hasMatches = didWrite
    ? successfulWrites.length > 0
    : approvedMatches.length > 0;

  if (!hasMatches) {
    const text = `\ud83d\udc4b Here's your end-of-day summary \u2014 ${today}\n\nQuiet day on the calendar. Nothing to log, but you can add time manually below.`;
    return {
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        buildSummaryActionButtons(),
      ],
    };
  }

  let matchedLines: string;
  let matchCount: number;

  if (didWrite && displayItems.length > 0) {
    matchCount = displayItems.length;
    matchedLines = displayItems
      .map((w) => {
        const match = matches.find(
          (m) =>
            m.project_name === w.project_name &&
            m.task_title === w.task_title
        );
        const event = events.find((e) => match && e.id === match.event_id);
        const time = event ? timeSlot(event.start, event.end) : "";
        const tag = rememberedIds.has(match?.event_id || "") ? "remembered" : w.confidence;
        return `\u2022 ${time} ${w.event_title} \u2192 ${w.project_name} (${tag})`;
      })
      .join("\n");
  } else {
    matchCount = approvedMatches.length;
    matchedLines = approvedMatches
      .map((m) => {
        const event = events.find((e) => e.id === m.event_id);
        const time = event ? timeSlot(event.start, event.end) : "";
        const title = event?.title || m.event_id;
        const tag = rememberedIds.has(m.event_id) ? "remembered" : m.confidence;
        return `\u2022 ${time} ${title} \u2192 ${m.project_name} (${tag})`;
      })
      .join("\n");
  }

  let body = `*I matched ${matchCount} event${matchCount === 1 ? "" : "s"} from your calendar:*\n${matchedLines}`;

  // Phase warnings: entries that landed on the wrong phase but were still written.
  // Blocked entries (BLOCK_WRONG_PHASE=true) have error set and render in the
  // "Failed to write" section below, so they're excluded here to avoid duplication.
  const phaseWarnings = written.filter((w) => w.phaseWarning && !w.error);
  if (phaseWarnings.length > 0) {
    const warningLines = phaseWarnings
      .map((w) => `\u2022 ${w.event_title}: ${w.phaseWarning}`)
      .join("\n");
    body += `\n\n\u26a0\ufe0f *Phase notes:*\n${warningLines}`;
  }

  // Task-uncertain: project matched but task is a guess (preview mode only)
  const taskUncertainBlocks: Record<string, unknown>[] = [];
  if (!didWrite) {
    const taskUncertain = approvedMatches.filter(
      (m) => m.task_confident === false && m.project_id !== null
    );
    if (taskUncertain.length > 0) {
      body += "\n\n*Pick the right task/role:*";
      for (let i = 0; i < taskUncertain.length; i++) {
        const m = taskUncertain[i];
        const project = activeProjects.find((p) => p.project_id === m.project_id);
        if (!project || project.tasks.length <= 1) continue;
        const event = events.find((e) => e.id === m.event_id);
        const title = event?.title || m.event_id;
        const time = event ? timeSlot(event.start, event.end) : "";
        const { options, initialOption } = buildTaskDropdownOptions(project, m.task_id);
        if (options.length === 0) continue;
        const accessory: Record<string, unknown> = {
          type: "static_select",
          action_id: "select_task",
          placeholder: { type: "plain_text", text: "Pick your role/task..." },
          options,
        };
        if (initialOption) accessory.initial_option = initialOption;
        taskUncertainBlocks.push({
          type: "section",
          block_id: `task_conf_${i}`,
          text: {
            type: "mrkdwn",
            text: `${time} *${title}* \u2192 ${m.project_name}`,
          },
          accessory,
        });
      }
    }
  }

  // Split skipped into non-trackable (lunch, personal) vs trackable-but-uncertain
  const nonTrackable = skipped.filter((s) => s.is_trackable === false);
  const uncertain = skipped.filter((s) => s.is_trackable !== false);

  // Non-trackable: simple "Not included" line, no dropdown
  if (nonTrackable.length > 0) {
    const names = nonTrackable
      .map((s) => {
        const event = events.find((e) => e.id === s.event_id);
        return event ? event.title : s.event_id;
      })
      .join(", ");
    body += `\n\n*Not included:* ${names} (not trackable work)`;
  }

  // Trackable but uncertain: dropdowns for project selection
  const lowConfBlocks: Record<string, unknown>[] = [];
  if (uncertain.length > 0 && activeProjects.length > 0) {
    body += `\n\n*Needs your input (${uncertain.length}):*`;
    for (let i = 0; i < uncertain.length; i++) {
      const s = uncertain[i];
      const event = events.find((e) => e.id === s.event_id);
      const title = event?.title || s.event_id;
      const time = event ? timeSlot(event.start, event.end) : "";
      lowConfBlocks.push({
        type: "section",
        block_id: `low_conf_${i}`,
        text: {
          type: "mrkdwn",
          text: `${time} *${title}*`,
        },
        accessory: {
          type: "external_select",
          action_id: "select_project",
          placeholder: { type: "plain_text", text: "Search for a project..." },
          min_query_length: 0,
        },
      });
    }
  } else if (uncertain.length > 0) {
    const names = uncertain
      .map((s) => {
        const event = events.find((e) => e.id === s.event_id);
        return event ? event.title : s.event_id;
      })
      .join(", ");
    body += `\n\n*Skipped:* ${names}`;
  }

  const failedEntries = written.filter((w) => w.error);
  if (failedEntries.length > 0) {
    const failedLines = failedEntries
      .map((w) => `\u2022 ${w.event_title}: ${w.error}`)
      .join("\n");
    body += `\n\n*Failed to write:*\n${failedLines}`;
  }

  if (didWrite) {
    body +=
      "\n\nI've saved these as drafts in Scoro. Give them a check when you get a chance.";
  } else {
    body +=
      "\n\nCheck these look right, then tap *Looks right* to save to Scoro.";
  }

  const text = `\ud83d\udc4b Here's your end-of-day summary \u2014 ${today}\n\n${body}`;

  return {
    text,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `\ud83d\udc4b Here's your end-of-day summary \u2014 ${today}`,
          emoji: true,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: body } },
      ...taskUncertainBlocks,
      ...lowConfBlocks,
      { type: "divider" },
      buildSummaryActionButtons(),
    ],
  };
}

interface SlackPostResult {
  status: string;
  channelId: string | null;
  messageTs: string | null;
}

async function postSlackMessage(
  channel: string,
  body: Record<string, unknown>
): Promise<SlackPostResult> {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!slackToken) {
    console.log("Slack not configured, skipping notification");
    return { status: "skipped: no token", channelId: null, messageTs: null };
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, ...body }),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        status: `failed: HTTP ${res.status} ${text}`,
        channelId: null,
        messageTs: null,
      };
    }

    const data = await res.json();
    if (!data.ok) {
      return {
        status: `failed: ${data.error || "unknown Slack API error"}`,
        channelId: null,
        messageTs: null,
      };
    }

    return {
      status: "sent",
      channelId: data.channel || null,
      messageTs: data.ts || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: `failed: ${msg}`, channelId: null, messageTs: null };
  }
}

// ---------------------------------------------------------------------------
// Scoro date checks (for day catch-up feature)
// ---------------------------------------------------------------------------
export async function checkScoroEntriesForDate(
  dateStr: string,
  scoroUserId: number
): Promise<{ hasEntries: boolean; count: number; error: boolean }> {
  try {
    const res = await scoroPost<Array<Record<string, unknown>>>("/timeEntries/list", {
      filter: {
        user_id: scoroUserId,
        start_date: dateStr,
        end_date: dateStr,
      },
      per_page: 1,
    });
    const entries = Array.isArray(res.data) ? res.data : [];
    return { hasEntries: entries.length > 0, count: entries.length, error: false };
  } catch {
    // Fail closed — if we can't verify, block the flow to avoid duplicates
    return { hasEntries: false, count: 0, error: true };
  }
}

export async function checkWeekSubmitted(
  dateStr: string,
  scoroUserId: number
): Promise<{ submitted: boolean; error: boolean }> {
  try {
    const res = await scoroPost<Array<Record<string, unknown>>>("/timeSheets/list", {
      filter: {
        user_id: scoroUserId,
        date: dateStr,
        status: "submitted",
      },
      per_page: 1,
    });
    const sheets = Array.isArray(res.data) ? res.data : [];
    return { submitted: sheets.length > 0, error: false };
  } catch {
    // Fail closed — if we can't verify, block the flow to avoid duplicates
    console.warn("Could not check timesheet submission status");
    return { submitted: false, error: true };
  }
}

// ---------------------------------------------------------------------------
// Main summary pipeline
// ---------------------------------------------------------------------------
export async function runCopilotSummary(
  slackId: string,
  options: {
    channelId?: string; // post to this channel; defaults to slackId (opens DM)
    writeToScoro?: boolean; // write drafts to Scoro; defaults to true
    projectLookup?: { projects: ProjectRecord[] }; // pre-fetched lookup to share across users
    targetDate?: Date; // run for a specific past date instead of today
    skipDedupe?: boolean; // bypass the "already sent today" check (used by catch-up)
  } = {}
): Promise<SummaryResult> {
  const { channelId = slackId, writeToScoro = true } = options;
  const cutoff = new Date();

  // 0. Load user prefs and validate Scoro user ID
  const prefs = await loadUserPrefs(slackId);

  // 0a. Duplicate guard — skip if today's summary was already sent
  const today = todayLondon();
  if (!options.skipDedupe && !options.targetDate && prefs.lastSummarySentDate === today) {
    return {
      eventCount: 0,
      matched: 0,
      failed: 0,
      skipped: 0,
      slackStatus: "skipped: already sent today",
      written: [],
      skippedEvents: [],
    };
  }

  if (!prefs.scoroUserId) {
    const errText = "Your Scoro user ID hasn't been set up yet. Please reconnect at /connect or ask Foluso to set it manually.";
    await postSlackMessage(channelId, {
      text: errText,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: errText } }],
    });
    return {
      eventCount: 0,
      matched: 0,
      failed: 0,
      skipped: 0,
      slackStatus: "blocked: no scoroUserId",
      written: [],
      skippedEvents: [],
    };
  }
  const scoroUserId = prefs.scoroUserId;

  // 1. Get Google access token
  const accessToken = await getAccessToken(slackId);

  // 2. Fetch calendar events (for targetDate or today)
  const events = await fetchDayEvents(accessToken, cutoff, options.targetDate);

  const displayDate = (options.targetDate || new Date()).toLocaleDateString(
    "en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" }
  );

  const demoBannerBlock = prefs.demoMode
    ? { type: "section", text: { type: "mrkdwn", text: DEMO_BANNER.trim() } }
    : null;

  if (events.length === 0) {
    const text = `\ud83d\udc4b Here's your end-of-day summary \u2014 ${displayDate}\n\nNo events on the calendar for ${options.targetDate ? "that day" : "today"}. You can still add time below if you need to.`;
    const emptyBlocks: Record<string, unknown>[] = [
      ...(demoBannerBlock ? [demoBannerBlock] : []),
      { type: "section", text: { type: "mrkdwn", text } },
      buildSummaryActionButtons(),
    ];
    const slackPost = await postSlackMessage(channelId, {
      text,
      blocks: emptyBlocks,
    });

    // Stamp today's date to prevent duplicate summaries
    if (!options.targetDate) {
      prefs.lastSummarySentDate = today;
      await saveUserPrefs(slackId, prefs);
    }

    const convo = newConversation(slackId, []);
    convo.step = "review_matches";
    convo.slackChannelId = slackPost.channelId;
    convo.messageTs = slackPost.messageTs;
    await saveConversation(convo);

    return {
      eventCount: 0,
      matched: 0,
      failed: 0,
      skipped: 0,
      slackStatus: slackPost.status,
      written: [],
      skippedEvents: [],
    };
  }

  // 3. Load project lookup (use pre-fetched if provided, otherwise fetch/cache)
  const lookup = options.projectLookup || (await getProjectLookup());
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );

  // 4. Check event memory for recurring meetings, then AI-match the rest
  const memory = await loadEventMemory(slackId);
  const rememberedIds = new Set<string>();
  const rememberedMatches: MatchResult[] = [];
  const unmatchedEvents: CalendarEvent[] = [];

  for (const ev of events) {
    const normalised = normaliseTitle(ev.title);
    const mapping = normalised ? memory[normalised] : null;
    // Verify the remembered project is still active
    const stillActive = mapping
      ? activeProjects.some((p) => p.project_id === mapping.project_id)
      : false;

    if (mapping && stillActive) {
      rememberedIds.add(ev.id);
      rememberedMatches.push({
        event_id: ev.id,
        project_id: mapping.project_id,
        project_name: mapping.project_name,
        client_name:
          activeProjects.find((p) => p.project_id === mapping.project_id)
            ?.client_name || null,
        task_id: mapping.task_id,
        task_title: mapping.task_title,
        confidence: "high",
        task_confident: true,
        description: `${ev.title} (remembered)`,
        is_internal: ev.isInternal,
        is_trackable: true,
        reasoning: "Matched from user's event memory",
      });
    } else {
      unmatchedEvents.push(ev);
    }
  }

  const aiMatches =
    unmatchedEvents.length > 0
      ? await matchEvents(unmatchedEvents, activeProjects)
      : [];
  const matches = [...rememberedMatches, ...aiMatches];

  // 4b. Apply remembered project→task mappings, then default role
  const projectTaskMem = await loadProjectTaskMemory(slackId);

  for (const m of matches) {
    if (m.task_confident || m.project_id === null) continue;
    const project = activeProjects.find((p) => p.project_id === m.project_id);
    if (!project) continue;

    // First: check per-project task memory (user previously picked a task here)
    const remembered = projectTaskMem[String(m.project_id)];
    if (remembered) {
      const taskStillExists = project.tasks.find(
        (t) => t.task_id === remembered.task_id
      );
      if (taskStillExists) {
        m.task_id = taskStillExists.task_id;
        m.task_title = taskStillExists.title;
        m.task_confident = true;
        continue;
      }
    }

    // Second: try exact defaultRole match
    if (prefs.defaultRole) {
      const roleLower = prefs.defaultRole.toLowerCase();
      const roleTask = project.tasks.find(
        (t) => t.title.toLowerCase() === roleLower
      );
      if (roleTask) {
        m.task_id = roleTask.task_id;
        m.task_title = roleTask.title;
        m.task_confident = true;
        continue;
      }
    }

    // No match found: mark as uncertain so the user gets a dropdown
    m.task_confident = false;
  }

  // 5. Optionally write approved drafts to Scoro
  let written: WriteResult[] = [];
  let skipped: MatchResult[] = [];

  if (writeToScoro) {
    const result = await writeDraftsToScoro(slackId, events, matches, scoroUserId);
    written = result.written;
    skipped = result.skipped;
  } else {
    // Still compute skipped for display, but don't write anything
    skipped = matches.filter(
      (m) =>
        m.is_trackable === false ||
        m.project_id === null ||
        m.task_id === null ||
        m.confidence === "low"
    );
  }

  // 6. Send Slack notification with interactive buttons
  const { text: summaryText, blocks } = formatSlackBlocks(
    events,
    written,
    skipped,
    matches,
    writeToScoro,
    activeProjects,
    rememberedIds,
    displayDate
  );

  // 6b. Append a rotating sign-off message
  const totalMinutes = events.reduce((sum, e) => {
    const ms = new Date(e.end).getTime() - new Date(e.start).getTime();
    return sum + Math.round(ms / 60000);
  }, 0);
  const signOff = await pickSignOff(slackId, totalMinutes);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${signOff}_` }],
  });

  const finalBlocks = demoBannerBlock ? [demoBannerBlock, ...blocks] : blocks;
  const slackPost = await postSlackMessage(channelId, {
    text: summaryText,
    blocks: finalBlocks,
  });

  // 6c. Stamp today's date to prevent duplicate summaries
  if (!options.targetDate) {
    prefs.lastSummarySentDate = today;
    await saveUserPrefs(slackId, prefs);
  }

  // 7. Create conversation state so user can interact via buttons
  const eventSummaries: CalendarEventSummary[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    isInternal: e.isInternal,
  }));
  // Only create drafts for trackable events (non-trackable are excluded entirely)
  const trackableMatches = matches.filter((m) => m.is_trackable !== false);
  const drafts: DraftEntry[] = trackableMatches.map((m) => {
    const event = events.find((e) => e.id === m.event_id);
    return {
      eventId: m.event_id,
      eventTitle: event?.title || "",
      projectId: m.project_id,
      projectName: m.project_name,
      taskId: m.task_id,
      taskTitle: m.task_title,
      confidence: m.confidence,
      description: m.description,
      approved:
        m.confidence !== "low" && m.project_id !== null && m.task_id !== null,
      remembered: rememberedIds.has(m.event_id),
      taskUncertain: m.task_confident === false && m.project_id !== null && m.confidence !== "low",
      scoroEntryId:
        written.find((w) => w.event_id === m.event_id)?.scoro_entry_id ?? null,
      durationMinutes: event
        ? Math.round(
            (new Date(event.end).getTime() -
              new Date(event.start).getTime()) /
              60000
          )
        : null,
      startDatetime: event?.start ?? null,
      endDatetime: event?.end ?? null,
    };
  });

  const convo = newConversation(slackId, eventSummaries);
  convo.step = "review_matches";
  convo.drafts = drafts;
  convo.slackChannelId = slackPost.channelId;
  convo.messageTs = slackPost.messageTs;
  await saveConversation(convo);

  // 8. Return result summary
  const successCount = written.filter((w) => !w.error).length;
  const failCount = written.filter((w) => w.error).length;

  return {
    eventCount: events.length,
    matched: successCount,
    failed: failCount,
    skipped: skipped.length,
    slackStatus: slackPost.status,
    written,
    skippedEvents: skipped.map((s) => ({
      event_id: s.event_id,
      description: s.description,
      confidence: s.confidence,
      reason:
        s.is_trackable === false
          ? "not trackable work"
          : s.project_id === null
            ? "no project match"
            : s.confidence === "low"
              ? "low confidence"
              : "no task match",
    })),
  };
}
