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
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const USER_ID = 107; // Foluso's Scoro user ID
const COPILOT_TAG = "[Co-pilot draft]";
const PROJECT_LOOKUP_KEY = "project_lookup";
const PROJECT_LOOKUP_TTL = 86400; // 24 hours

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

interface TaskRecord {
  task_id: number;
  title: string;
  activity_id: number | null;
  activity_name: string | null;
  status: string;
  assigned_user_ids: number[];
}

interface ProjectRecord {
  project_id: number;
  name: string;
  client_name: string;
  status: string;
  status_id: number | string | null;
  manager_id: number | null;
  team_user_ids: number[];
  start_date: string | null;
  end_date: string | null;
  tasks: TaskRecord[];
}

interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
}

interface ScoroProject {
  project_id: number;
  no?: string;
  project_name?: string;
  name?: string;
  company_id?: number;
  company_name?: string;
  status?: string;
  status_id?: number | string;
  manager_id?: number;
  project_users?: Array<{ id: string; email: string }>;
  members?: number[];
  team?: number[];
  assigned_users?: number[];
  date?: string;
  start_date?: string;
  end_date?: string;
  deadline?: string;
  is_deleted?: number;
  [key: string]: unknown;
}

interface ScoroTask {
  event_id: number;
  event_name: string;
  activity_id?: number;
  activity_type?: string;
  status: string;
  is_completed: number;
  assigned_to?: number;
  related_users?: number[];
  [key: string]: unknown;
}

interface MatchResult {
  event_id: string;
  project_id: number | null;
  project_name: string | null;
  client_name: string | null;
  task_id: number | null;
  task_title: string | null;
  confidence: "high" | "medium" | "low";
  description: string;
  is_internal: boolean;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Scoro API helper
// ---------------------------------------------------------------------------
function scoroBaseUrl(): string {
  return `https://${process.env.SCORO_SUBDOMAIN}.scoro.com/api/v2`;
}

async function scoroPost<T = unknown>(
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<ScoroResponse<T>> {
  const url = `${scoroBaseUrl()}${endpoint}`;
  const body = {
    apiKey: process.env.SCORO_API_KEY,
    company_account_id: process.env.SCORO_ACCOUNT_ID,
    ...payload,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as ScoroResponse<T>;

  if (!res.ok || json.status === "ERROR") {
    const errMsg = json.messages?.error?.join("; ") || `HTTP ${res.status}`;
    throw new Error(`Scoro ${endpoint}: [${res.status}] ${errMsg}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Upstash helpers
// ---------------------------------------------------------------------------
async function getRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

// ---------------------------------------------------------------------------
// Step 1: Fetch today's calendar events
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
// Step 2: Project lookup (cached in Upstash)
// ---------------------------------------------------------------------------
interface ProjectLookup {
  generated_at: string;
  project_count: number;
  projects: ProjectRecord[];
}

async function fetchAllProjects(): Promise<ScoroProject[]> {
  const allProjects: ScoroProject[] = [];
  let page = 1;
  const perPage = 25;

  while (true) {
    const res = await scoroPost<ScoroProject[]>("/projects/list", {
      per_page: perPage,
      page,
      detailed_response: true,
    });
    const projects = Array.isArray(res.data) ? res.data : [];
    if (projects.length === 0) break;
    allProjects.push(...projects);
    if (projects.length < perPage) break;
    page++;
  }

  return allProjects;
}

async function fetchProjectTasks(projectId: number): Promise<TaskRecord[]> {
  const allTasks: ScoroTask[] = [];
  let page = 1;

  while (true) {
    const res = await scoroPost<ScoroTask[]>("/tasks/list", {
      filter: { project_id: projectId },
      per_page: 100,
      page,
    });
    const tasks = Array.isArray(res.data) ? res.data : [];
    allTasks.push(...tasks);
    if (tasks.length < 100) break;
    page++;
  }

  const active = allTasks.filter((t) => t.is_completed === 0);

  const seen = new Map<string, TaskRecord>();
  for (const t of active) {
    const name = t.event_name || "Untitled";
    if (!seen.has(name)) {
      seen.set(name, {
        task_id: t.event_id,
        title: name,
        activity_id: t.activity_id || null,
        activity_name: t.activity_type || null,
        status: t.status,
        assigned_user_ids:
          t.related_users || (t.assigned_to ? [t.assigned_to] : []),
      });
    }
  }

  return [...seen.values()];
}

function extractTeam(p: ScoroProject): number[] {
  if (Array.isArray(p.project_users) && p.project_users.length > 0) {
    return p.project_users
      .map((u) => parseInt(u.id, 10))
      .filter((id) => !isNaN(id));
  }
  if (Array.isArray(p.members) && p.members.length > 0) return p.members;
  if (Array.isArray(p.team) && p.team.length > 0) return p.team;
  if (Array.isArray(p.assigned_users) && p.assigned_users.length > 0)
    return p.assigned_users;
  return [];
}

async function buildProjectLookup(): Promise<ProjectLookup> {
  const allProjects = await fetchAllProjects();

  const records: ProjectRecord[] = allProjects.map((p) => ({
    project_id: p.project_id,
    name: p.project_name || p.name || "",
    client_name: p.company_name || "",
    status: p.status || "unknown",
    status_id: p.status_id ?? null,
    manager_id: p.manager_id ?? null,
    team_user_ids: extractTeam(p),
    start_date: p.start_date || p.date || null,
    end_date: p.end_date || p.deadline || null,
    tasks: [],
  }));

  const activeRecords = records.filter((r) => r.status === "inprogress");

  for (const r of activeRecords) {
    r.tasks = await fetchProjectTasks(r.project_id);
  }

  return {
    generated_at: new Date().toISOString(),
    project_count: records.length,
    projects: records,
  };
}

async function getProjectLookup(): Promise<ProjectLookup> {
  const redis = await getRedis();

  const cached = await redis.get<string>(PROJECT_LOOKUP_KEY);
  if (cached) {
    const lookup: ProjectLookup =
      typeof cached === "string" ? JSON.parse(cached) : cached;
    const age =
      (Date.now() - new Date(lookup.generated_at).getTime()) / 1000;
    if (age < PROJECT_LOOKUP_TTL) {
      return lookup;
    }
  }

  const lookup = await buildProjectLookup();
  await redis.set(PROJECT_LOOKUP_KEY, JSON.stringify(lookup), {
    ex: PROJECT_LOOKUP_TTL,
  });
  return lookup;
}

// ---------------------------------------------------------------------------
// Step 3: AI matching
// ---------------------------------------------------------------------------
function timeSlot(startISO: string, endISO: string): string {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(s)}-${fmt(e)}`;
}

async function matchEvents(
  events: CalendarEvent[],
  projects: ProjectRecord[]
): Promise<MatchResult[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const projectBlocks = projects.map((p) => {
    const taskLines =
      p.tasks.length > 0
        ? p.tasks.map((t) => `    ${t.task_id} | ${t.title}`).join("\n")
        : "    (no tasks)";
    return `${p.project_id} | ${p.name} | ${p.client_name}\n${taskLines}`;
  });

  const systemPrompt = `You are a timesheet assistant for Campfire, a social-first marketing agency. Match calendar events to active projects AND a specific task within that project.

ACTIVE PROJECTS (project_id | name | client) with their tasks (task_id | title):
${projectBlocks.join("\n")}

RULES:
- Match each event to ONE project and ONE task within it, or null if no good match.
- Pick the task whose title best fits the event context: "creative review" -> a Creative role/task; "shoot brief" -> a Production or Creator Marketing task; "retainer review" -> Account Manager task; vague meetings -> a general/admin task if available.
- If no task is a strong fit, pick the first available task for that project.
- "high" confidence: clear brand/client name match in event title or attendee domain.
- "medium" confidence: likely match from partial name, context clues, or attendee domain.
- "low" confidence: weak or ambiguous signal.
- Internal meetings (standups, 1:1s, all-hands) with only @campfire.co.uk attendees should map to the internal time project and an appropriate task, flagged as is_internal: true.
- If the event is too vague to match any project, return null for project_id and task_id with low confidence.
- Description: concise summary for a Scoro time entry.

Respond with ONLY a JSON array. Each element:
{"event_id":"...","project_id":number|null,"project_name":"..."|null,"client_name":"..."|null,"task_id":number|null,"task_title":"..."|null,"confidence":"high"|"medium"|"low","description":"...","is_internal":boolean,"reasoning":"one sentence"}`;

  const userMessage = JSON.stringify(
    events.map((e) => ({
      id: e.id,
      title: e.title,
      time: timeSlot(e.start, e.end),
      attendees: e.attendees,
    }))
  );

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Claude did not return valid JSON");
  }

  return JSON.parse(jsonMatch[0]);
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
async function sendSlackSummary(
  events: CalendarEvent[],
  written: WriteResult[],
  skipped: MatchResult[],
  matches: MatchResult[]
): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackUser = process.env.SLACK_USER_ID;

  if (!slackToken || !slackUser) {
    console.log("Slack not configured, skipping notification");
    return;
  }

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const matchedLines = written
    .filter((w) => !w.error)
    .map((w) => {
      const match = matches.find(
        (m) => m.project_name === w.project_name && m.task_title === w.task_title
      );
      const event = events.find(
        (e) => match && e.id === match.event_id
      );
      const time = event ? timeSlot(event.start, event.end) : "";
      return `\u2022 ${time} ${w.event_title} \u2192 ${w.project_name} (${w.confidence})`;
    })
    .join("\n");

  const skippedNames = skipped
    .map((s) => {
      const event = events.find((e) => e.id === s.event_id);
      return event ? event.title : s.event_id;
    })
    .join(", ");

  const failedEntries = written.filter((w) => w.error);
  const failedLines = failedEntries
    .map((w) => `\u2022 ${w.event_title}: ${w.error}`)
    .join("\n");

  let message = `\ud83d\udcc5 Timesheet draft ready \u2014 ${today}\n\nMatched ${written.filter((w) => !w.error).length} events:\n${matchedLines}`;

  if (skipped.length > 0) {
    message += `\n\nSkipped: ${skippedNames}`;
  }

  if (failedEntries.length > 0) {
    message += `\n\nFailed to write:\n${failedLines}`;
  }

  message += "\n\nWritten to Scoro as drafts. Review and submit by Friday.";

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: slackUser,
      text: message,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Slack API failed: ${res.status} ${body}`);
  }
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
    // 1. Get Google access token
    const accessToken = await getAccessToken();

    // 2. Fetch today's calendar events
    const events = await fetchTodayEvents(accessToken);

    if (events.length === 0) {
      return NextResponse.json({
        message: "No events today",
        entries: [],
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

    // 6. Send Slack notification
    await sendSlackSummary(events, written, skipped, matches);

    // 7. Return summary
    const successCount = written.filter((w) => !w.error).length;
    const failCount = written.filter((w) => w.error).length;

    return NextResponse.json({
      message: `Processed ${events.length} events`,
      matched: successCount,
      failed: failCount,
      skipped: skipped.length,
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
