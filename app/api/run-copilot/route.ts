// Required env vars:
//   CRON_SECRET            - Bearer token for authenticating cron/Slack requests
//   SCORO_SUBDOMAIN        - Scoro instance subdomain
//   SCORO_API_KEY          - Scoro API key
//   SCORO_ACCOUNT_ID       - Scoro company account ID
//   ANTHROPIC_API_KEY      - Claude API key for AI matching
//   GOOGLE_CLIENT_ID       - Google OAuth client ID (for token refresh)
//   GOOGLE_CLIENT_SECRET   - Google OAuth client secret
//   KV_REST_API_URL        - Upstash Redis REST URL
//   KV_REST_API_TOKEN      - Upstash Redis REST token
//
// Optional env vars:
//   SLACK_BOT_TOKEN        - Slack bot OAuth token for DM notifications
//   SLACK_USER_ID          - Slack user ID to receive the DM

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/google-auth";
import {
  newConversation,
  saveConversation,
  CalendarEventSummary,
  DraftEntry,
} from "@/lib/conversation";
import {
  matchEvents,
  getProjectLookup,
  scoroPost,
  timeSlot,
  MatchResult,
} from "@/lib/matcher";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const USER_ID = 107; // Foluso's Scoro user ID
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

// ---------------------------------------------------------------------------
// Fetch today's calendar events
// ---------------------------------------------------------------------------
function isInternalEmail(email: string): boolean {
  return (
    email.endsWith("@campfire.co.uk") ||
    email.endsWith("@resource.calendar.google.com")
  );
}

async function fetchTodayEvents(
  accessToken: string
): Promise<CalendarEvent[]> {
  const now = new Date();
  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
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
// Step 4: Write to Scoro
// ---------------------------------------------------------------------------
function durationStr(startISO: string, endISO: string): string {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  const totalMins = Math.round(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

interface WriteResult {
  event_title: string;
  project_name: string | null;
  task_title: string | null;
  confidence: string;
  scoro_entry_id: number | null;
  error: string | null;
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
      user_id: USER_ID,
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
// Step 5: Slack notification
// ---------------------------------------------------------------------------
interface SlackPostResult {
  status: string;
  channelId: string | null;
  messageTs: string | null;
}

async function postSlackMessage(
  body: Record<string, unknown>
): Promise<SlackPostResult> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackUser = process.env.SLACK_USER_ID;

  if (!slackToken || !slackUser) {
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
      body: JSON.stringify({ channel: slackUser, ...body }),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildActionButtons(): Record<string, unknown> {
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
        text: { type: "plain_text", text: "\u270f\ufe0f Fix an entry", emoji: true },
        action_id: "fix_entry",
      },
    ],
  };
}

function formatSlackBlocks(
  events: CalendarEvent[],
  written: WriteResult[],
  skipped: MatchResult[],
  matches: MatchResult[]
): { text: string; blocks: Record<string, unknown>[] } {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const successfulWrites = written.filter((w) => !w.error);

  if (successfulWrites.length === 0) {
    const text = `\ud83d\udcc5 Timesheet Co-pilot ran \u2014 ${today}\n\nNo billable events found today. Nothing written to Scoro.`;
    return {
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        buildActionButtons(),
      ],
    };
  }

  const matchedLines = successfulWrites
    .map((w) => {
      const match = matches.find(
        (m) => m.project_name === w.project_name && m.task_title === w.task_title
      );
      const event = events.find((e) => match && e.id === match.event_id);
      const time = event ? timeSlot(event.start, event.end) : "";
      return `\u2022 ${time} ${w.event_title} \u2192 ${w.project_name} (${w.confidence})`;
    })
    .join("\n");

  let body = `*Matched ${successfulWrites.length} events:*\n${matchedLines}`;

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

  body += "\n\nWritten to Scoro as drafts. Review and submit by Friday.";

  const text = `\ud83d\udcc5 Timesheet draft ready \u2014 ${today}\n\n${body}`;

  return {
    text,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `\ud83d\udcc5 Timesheet draft ready \u2014 ${today}`,
          emoji: true,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: body } },
      { type: "divider" },
      buildActionButtons(),
    ],
  };
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    // 1. Get Google access token (single-user for now; multi-user loop comes next)
    const slackId = process.env.SLACK_USER_ID!;
    const accessToken = await getAccessToken(slackId);

    // 2. Fetch today's calendar events
    const events = await fetchTodayEvents(accessToken);

    if (events.length === 0) {
      const today = new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      const text = `\ud83d\udcc5 Timesheet Co-pilot ran \u2014 ${today}\n\nNo events found on the calendar today. Nothing written to Scoro.`;
      const slackPost = await postSlackMessage({
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          buildActionButtons(),
        ],
      });

      // Create conversation state even with no events so user can "Add time"
      const convo = newConversation(slackId, []);
      convo.step = "review_matches";
      convo.slackChannelId = slackPost.channelId;
      convo.messageTs = slackPost.messageTs;
      await saveConversation(convo);

      return NextResponse.json({
        message: "No events today",
        entries: [],
        slack_result: slackPost.status,
      });
    }

    // 3. Load project lookup (cached in Upstash)
    const lookup = await getProjectLookup();
    const activeProjects = lookup.projects.filter(
      (p) => p.status === "inprogress"
    );

    // 4. Run AI matcher
    const matches = await matchEvents(events, activeProjects);

    // 5. Write approved drafts to Scoro
    const { written, skipped } = await writeDraftsToScoro(events, matches);

    // 6. Send Slack notification with interactive buttons
    const { text: summaryText, blocks } = formatSlackBlocks(
      events,
      written,
      skipped,
      matches
    );
    const slackPost = await postSlackMessage({ text: summaryText, blocks });

    // 7. Create conversation state so user can interact via buttons
    const eventSummaries: CalendarEventSummary[] = events.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      isInternal: e.isInternal,
    }));
    const drafts: DraftEntry[] = matches.map((m) => ({
      eventId: m.event_id,
      eventTitle: events.find((e) => e.id === m.event_id)?.title || "",
      projectId: m.project_id,
      projectName: m.project_name,
      taskId: m.task_id,
      taskTitle: m.task_title,
      confidence: m.confidence,
      description: m.description,
      approved: m.confidence !== "low" && m.project_id !== null && m.task_id !== null,
      scoroEntryId:
        written.find((w) => w.project_name === m.project_name && w.task_title === m.task_title)
          ?.scoro_entry_id ?? null,
    }));

    const convo = newConversation(slackId, eventSummaries);
    convo.step = "review_matches";
    convo.drafts = drafts;
    convo.slackChannelId = slackPost.channelId;
    convo.messageTs = slackPost.messageTs;
    await saveConversation(convo);

    // 8. Return summary
    const successCount = written.filter((w) => !w.error).length;
    const failCount = written.filter((w) => w.error).length;

    return NextResponse.json({
      message: `Processed ${events.length} events`,
      matched: successCount,
      failed: failCount,
      skipped: skipped.length,
      slack_result: slackPost.status,
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("run-copilot error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
