import "server-only";
import { getRedis } from "./redis";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TaskRecord {
  task_id: number;
  title: string;
  activity_id: number | null;
  activity_name: string | null;
  status: string;
  assigned_user_ids: number[];
}

export interface ProjectRecord {
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

export interface MatchResult {
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

interface MatchInput {
  id: string;
  title: string;
  time?: string;
  attendees?: string[];
}

// ---------------------------------------------------------------------------
// Scoro API (for project lookup)
// ---------------------------------------------------------------------------
interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
}

interface ScoroProject {
  project_id: number;
  project_name?: string;
  name?: string;
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

function scoroBaseUrl(): string {
  return `https://${process.env.SCORO_SUBDOMAIN}.scoro.com/api/v2`;
}

export async function scoroPost<T = unknown>(
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
// Project lookup (cached in Upstash)
// ---------------------------------------------------------------------------
const PROJECT_LOOKUP_KEY = "project_lookup";
const PROJECT_LOOKUP_TTL = 86400; // 24 hours

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

export async function getProjectLookup(): Promise<ProjectLookup> {
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
// AI matching — shared by run-copilot and Slack free-text input
// ---------------------------------------------------------------------------
export function timeSlot(startISO: string, endISO: string): string {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(s)}-${fmt(e)}`;
}

// ---------------------------------------------------------------------------
// AI activity splitting — extract individual time entries from free text
// ---------------------------------------------------------------------------
export interface SplitActivity {
  id: string;
  title: string;
  durationMinutes: number;
}

export async function splitActivities(text: string): Promise<SplitActivity[]> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: `You extract time entries from a free-text message. Split the message into individual activities, each with its duration in minutes.

RULES:
- Each activity must be a distinct piece of work with its own duration.
- Parse durations: "30 mins", "1 hour", "1.5h", "2h30m", "an hour", "half an hour", "90 minutes", etc.
- If the message describes multiple activities (connected by "and", "then", "plus", commas, semicolons, etc.), split them into separate items.
- If the message describes only one activity, return a single item.
- Preserve client names, project names, and activity descriptions in "title" so they can be matched to projects.
- Do NOT invent durations. If no duration is mentioned for an activity, set durationMinutes to 0.
- "title" should be a natural description suitable for project matching, not just the time component.

Respond with ONLY a JSON array:
[{"id":"1","title":"description for matching","durationMinutes":number}]`,
    messages: [{ role: "user", content: text }],
  });

  const responseText =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const activities: SplitActivity[] = JSON.parse(jsonMatch[0]);
  return activities.map((a, i) => ({
    ...a,
    id: `manual-${i + 1}`,
  }));
}

export async function matchEvents(
  events: MatchInput[],
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
      time: e.time,
      attendees: e.attendees || [],
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
