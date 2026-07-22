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
  MatchResult,
} from "./matcher";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCORO_USER_ID = 107; // TEMP: Foluso's Scoro user ID, hardcoded for single-user
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
  event_title: string;
  project_name: string | null;
  task_title: string | null;
  confidence: string;
  scoro_entry_id: number | null;
  error: string | null;
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

async function fetchTodayEvents(
  accessToken: string,
  cutoff: Date
): Promise<CalendarEvent[]> {
  const startOfDay = new Date(
    cutoff.getFullYear(),
    cutoff.getMonth(),
    cutoff.getDate()
  );

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: cutoff.toISOString(),
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
  events: CalendarEvent[],
  matches: MatchResult[]
): Promise<{ written: WriteResult[]; skipped: MatchResult[] }> {
  const approved = matches.filter(
    (m) =>
      m.project_id !== null &&
      m.task_id !== null &&
      (m.confidence === "high" || m.confidence === "medium")
  );
  const skipped = matches.filter(
    (m) =>
      m.project_id === null ||
      m.task_id === null ||
      m.confidence === "low"
  );

  const written: WriteResult[] = [];

  for (const match of approved) {
    const event = events.find((e) => e.id === match.event_id);
    if (!event) continue;

    const description = `${COPILOT_TAG} ${match.description}`;

    const payload: Record<string, unknown> = {
      event_id: match.task_id,
      user_id: SCORO_USER_ID,
      start_datetime: event.start,
      end_datetime: event.end,
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
        event_title: event.title,
        project_name: match.project_name,
        task_title: match.task_title,
        confidence: match.confidence,
        scoro_entry_id: entryId,
        error: null,
      });
    } catch (err) {
      written.push({
        event_title: event.title,
        project_name: match.project_name,
        task_title: match.task_title,
        confidence: match.confidence,
        scoro_entry_id: null,
        error: err instanceof Error ? err.message : String(err),
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
          text: "\ud83d\udd04 Wrap up my day",
          emoji: true,
        },
        action_id: "wrap_up",
      },
    ],
  };
}

function formatSlackBlocks(
  events: CalendarEvent[],
  written: WriteResult[],
  skipped: MatchResult[],
  matches: MatchResult[],
  didWrite: boolean
): { text: string; blocks: Record<string, unknown>[] } {
  const today = new Date().toLocaleDateString("en-GB", {
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
        return `\u2022 ${time} ${w.event_title} \u2192 ${w.project_name} (${w.confidence})`;
      })
      .join("\n");
  } else {
    matchCount = approvedMatches.length;
    matchedLines = approvedMatches
      .map((m) => {
        const event = events.find((e) => e.id === m.event_id);
        const time = event ? timeSlot(event.start, event.end) : "";
        const title = event?.title || m.event_id;
        return `\u2022 ${time} ${title} \u2192 ${m.project_name} (${m.confidence})`;
      })
      .join("\n");
  }

  let body = `*I matched ${matchCount} event${matchCount === 1 ? "" : "s"} from your calendar:*\n${matchedLines}`;

  if (skipped.length > 0) {
    const skippedNames = skipped
      .map((s) => {
        const event = events.find((e) => e.id === s.event_id);
        return event ? event.title : s.event_id;
      })
      .join(", ");
    body += `\n\n*Skipped:* ${skippedNames}`;
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
// Main summary pipeline
// ---------------------------------------------------------------------------
export async function runCopilotSummary(
  slackId: string,
  options: {
    channelId?: string; // post to this channel; defaults to slackId (opens DM)
    writeToScoro?: boolean; // write drafts to Scoro; defaults to true
  } = {}
): Promise<SummaryResult> {
  const { channelId = slackId, writeToScoro = true } = options;
  const cutoff = new Date();

  // 1. Get Google access token
  const accessToken = await getAccessToken(slackId);

  // 2. Fetch today's calendar events (only those that have started by now)
  const events = await fetchTodayEvents(accessToken, cutoff);

  if (events.length === 0) {
    const today = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const text = `\ud83d\udc4b Here's your end-of-day summary \u2014 ${today}\n\nNo events on the calendar today. You can still add time below if you need to.`;
    const slackPost = await postSlackMessage(channelId, {
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        buildSummaryActionButtons(),
      ],
    });

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

  // 3. Load project lookup (cached in Upstash)
  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );

  // 4. Run AI matcher
  const matches = await matchEvents(events, activeProjects);

  // 5. Optionally write approved drafts to Scoro
  let written: WriteResult[] = [];
  let skipped: MatchResult[] = [];

  if (writeToScoro) {
    const result = await writeDraftsToScoro(events, matches);
    written = result.written;
    skipped = result.skipped;
  } else {
    // Still compute skipped for display, but don't write anything
    skipped = matches.filter(
      (m) =>
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
    writeToScoro
  );
  const slackPost = await postSlackMessage(channelId, {
    text: summaryText,
    blocks,
  });

  // 7. Create conversation state so user can interact via buttons
  const eventSummaries: CalendarEventSummary[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    isInternal: e.isInternal,
  }));
  const drafts: DraftEntry[] = matches.map((m) => {
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
      scoroEntryId:
        written.find(
          (w) =>
            w.project_name === m.project_name && w.task_title === m.task_title
        )?.scoro_entry_id ?? null,
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
        s.project_id === null
          ? "no project match"
          : s.confidence === "low"
            ? "low confidence"
            : "no task match",
    })),
  };
}
