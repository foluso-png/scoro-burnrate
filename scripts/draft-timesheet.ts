import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  process.env[key] = value;
}

const SCORO_SUBDOMAIN = process.env.SCORO_SUBDOMAIN!;
const SCORO_API_KEY = process.env.SCORO_API_KEY!;
const SCORO_ACCOUNT_ID = process.env.SCORO_ACCOUNT_ID!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SCORO_SUBDOMAIN || !SCORO_API_KEY || !SCORO_ACCOUNT_ID) {
  console.error("Missing Scoro env vars. Check .env.local");
  process.exit(1);
}

if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env.local. Add it and re-run.");
  process.exit(1);
}

const BASE_URL = `https://${SCORO_SUBDOMAIN}.scoro.com/api/v2`;
const USER_ID = 107; // Foluso
const COPILOT_TAG = "[Co-pilot draft]";

// ---------------------------------------------------------------------------
// Scoro API helper
// ---------------------------------------------------------------------------
interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
}

async function scoroPost<T = unknown>(
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<ScoroResponse<T>> {
  const url = `${BASE_URL}${endpoint}`;
  const body = {
    apiKey: SCORO_API_KEY,
    company_account_id: SCORO_ACCOUNT_ID,
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
    throw new Error(`[${res.status}] ${errMsg}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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

interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO datetime
  end: string;
  attendees: string[]; // email addresses
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
// Helpers
// ---------------------------------------------------------------------------
function todayISO(hour: number, minute: number = 0): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hh = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const mm = String(absOffset % 60).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  // We want the specified hour/minute, not current time
  return `${yyyy}-${mo}-${dd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${sign}${hh}:${mm}`;
}

function dateStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd}`;
}

function durationStr(startISO: string, endISO: string): string {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  const totalMins = Math.round(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function durationMins(startISO: string, endISO: string): number {
  return Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 60000);
}

function timeSlot(startISO: string, endISO: string): string {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${fmt(s)}-${fmt(e)}`;
}

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------
// Mock calendar events
// ---------------------------------------------------------------------------
function getMockEvents(): CalendarEvent[] {
  return [
    {
      id: "mock-1",
      title: "Wella FY27 retainer review",
      start: todayISO(9, 0),
      end: todayISO(9, 45),
      attendees: ["foluso@campfire.co.uk", "sarah.jones@wella.com", "mike.chen@wella.com"],
    },
    {
      id: "mock-2",
      title: "St Tropez summer shoot brief",
      start: todayISO(10, 0),
      end: todayISO(11, 0),
      attendees: ["foluso@campfire.co.uk", "kate@campfire.co.uk"],
    },
    {
      id: "mock-3",
      title: "Team standup",
      start: todayISO(11, 30),
      end: todayISO(12, 0),
      attendees: ["foluso@campfire.co.uk", "joe@campfire.co.uk", "hannah.griffin@campfire.co.uk"],
    },
    {
      id: "mock-4",
      title: "Persil creative review with Unilever",
      start: todayISO(14, 0),
      end: todayISO(15, 0),
      attendees: ["foluso@campfire.co.uk", "claire.m@unilever.com"],
    },
    {
      id: "mock-5",
      title: "Quick chat re: timelines",
      start: todayISO(16, 0),
      end: todayISO(16, 15),
      attendees: ["foluso@campfire.co.uk", "joe@campfire.co.uk"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Claude matching
// ---------------------------------------------------------------------------
async function matchEvents(
  events: CalendarEvent[],
  projects: ProjectRecord[]
): Promise<{ matches: MatchResult[]; inputTokens: number; outputTokens: number }> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Build compact project+tasks list. Only include projects that have tasks.
  const projectBlocks = projects.map((p) => {
    const taskLines = p.tasks.length > 0
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

  // Extract JSON from response (handle markdown code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("Failed to parse Claude response:", text);
    throw new Error("Claude did not return valid JSON");
  }

  const matches: MatchResult[] = JSON.parse(jsonMatch[0]);

  return {
    matches,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Cleanup mode
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  console.log(`=== CLEANUP: Removing ${COPILOT_TAG} entries ===\n`);

  // Paginate through all entries for this user to find co-pilot drafts
  // (date filters are unreliable in Scoro's timeEntries/list)
  const allEntries: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const res = await scoroPost<Record<string, unknown>[]>("/timeEntries/list", {
      filter: { user_id: USER_ID },
      per_page: 100,
      page,
    });
    const entries = Array.isArray(res.data) ? res.data : [];
    allEntries.push(...entries);
    if (entries.length < 100) break;
    page++;
  }

  const copilotEntries = allEntries.filter((e) =>
    String(e.description || "").includes(COPILOT_TAG)
  );

  if (copilotEntries.length === 0) {
    console.log("No Co-pilot draft entries found for today.");
    return;
  }

  console.log(`Found ${copilotEntries.length} Co-pilot draft(s). Deleting...\n`);

  for (const entry of copilotEntries) {
    const id = (entry.time_entry_id as number) || (entry.id as number);
    const desc = String(entry.description || "");
    try {
      await scoroPost(`/timeEntries/delete/${id}`, {});
      console.log(`  Deleted entry ${id}: ${desc}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Failed to delete entry ${id}: ${msg}`);
    }
  }

  console.log("\nCleanup complete.");
}

// ---------------------------------------------------------------------------
// Write to Scoro
// ---------------------------------------------------------------------------
async function writeToScoro(
  events: CalendarEvent[],
  matches: MatchResult[]
): Promise<void> {
  console.log("\n=== Writing draft time entries to Scoro ===\n");

  const writable = matches.filter((m) => m.project_id !== null && m.task_id !== null);
  const skipped = matches.filter((m) => m.project_id === null || m.task_id === null);

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} unmatched/internal event(s):`);
    for (const m of skipped) {
      console.log(`  - ${m.event_id}: ${m.description} (${m.is_internal ? "internal" : "no match"})`);
    }
    console.log("");
  }

  for (const match of writable) {
    const event = events.find((e) => e.id === match.event_id);
    if (!event) continue;

    if (!match.task_id) {
      console.log(`  Skipping ${match.project_name}: no task_id selected by matcher`);
      continue;
    }

    const description = `${COPILOT_TAG} ${match.description}`;

    const payload: Record<string, unknown> = {
      event_id: match.task_id, // Scoro uses event_id to reference the task
      user_id: USER_ID,
      start_datetime: event.start,
      end_datetime: event.end,
      duration: durationStr(event.start, event.end),
      description,
      is_completed: false,
    };

    console.log(`Writing: ${timeSlot(event.start, event.end)} | ${match.project_name}`);
    console.log(`  Task:        [${match.task_id}] ${match.task_title}`);
    console.log(`  Description: ${description}`);

    try {
      const res = await scoroPost<Record<string, unknown>>("/timeEntries/modify", {
        request: payload,
      });
      const entryId =
        (res.data.time_entry_id as number) || (res.data.id as number);
      console.log(`  Created entry ID: ${entryId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--cleanup")) {
    await cleanup();
    return;
  }

  const startTime = Date.now();

  console.log("=== Timesheet Co-pilot: Draft Timesheet ===\n");

  // 1. Load project lookup
  const lookupPath = path.resolve(__dirname, "..", "data", "project-lookup.json");
  if (!fs.existsSync(lookupPath)) {
    console.error("data/project-lookup.json not found. Run build-project-lookup.ts first.");
    process.exit(1);
  }

  const lookup = JSON.parse(fs.readFileSync(lookupPath, "utf-8"));
  const activeProjects: ProjectRecord[] = lookup.projects.filter(
    (p: ProjectRecord) => p.status === "inprogress"
  );
  console.log(`Loaded ${activeProjects.length} active projects from lookup.\n`);

  // 2. Generate mock events
  const events = getMockEvents();
  console.log(`${events.length} calendar events for today:\n`);
  for (const e of events) {
    const slot = timeSlot(e.start, e.end);
    const attendeeStr = e.attendees.filter((a) => !a.includes("campfire")).join(", ") || "(internal only)";
    console.log(`  ${slot}  ${e.title}`);
    console.log(`           Attendees: ${attendeeStr}`);
  }
  console.log("");

  // 3. Match with Claude
  console.log("Matching events to projects via Claude Sonnet 4.6...\n");
  const matchStart = Date.now();
  const { matches, inputTokens, outputTokens } = await matchEvents(events, activeProjects);
  const matchDuration = Date.now() - matchStart;

  // 4. Display proposal
  console.log("=".repeat(70));
  console.log("  PROPOSED TIMESHEET DRAFT");
  console.log("=".repeat(70));
  console.log("");

  let totalBillableMins = 0;
  let totalNonBillableMins = 0;

  for (const match of matches) {
    const event = events.find((e) => e.id === match.event_id)!;
    const mins = durationMins(event.start, event.end);
    const slot = timeSlot(event.start, event.end);
    const isBillable = match.project_id !== null && !match.is_internal;

    if (isBillable) {
      totalBillableMins += mins;
    } else {
      totalNonBillableMins += mins;
    }

    const confidenceFlag =
      match.confidence === "low" ? " *** LOW CONFIDENCE ***" :
      match.confidence === "medium" ? " * MEDIUM *" : "";

    const matchLine = match.project_id
      ? `[${match.project_id}] ${match.project_name} (${match.client_name})`
      : "UNMATCHED";
    const taskLine = match.task_id
      ? `[${match.task_id}] ${match.task_title}`
      : "NONE";

    console.log(`  ${slot}  ${event.title}`);
    console.log(`  Project:     ${matchLine}${confidenceFlag}`);
    console.log(`  Task:        ${taskLine}`);
    console.log(`  Description: ${match.description}`);
    console.log(`  Internal:    ${match.is_internal ? "Yes" : "No"}`);
    console.log(`  Confidence:  ${match.confidence}`);
    console.log(`  Reasoning:   ${match.reasoning}`);
    console.log("");
  }

  console.log("-".repeat(70));

  const billableH = Math.floor(totalBillableMins / 60);
  const billableM = totalBillableMins % 60;
  const nonBillableH = Math.floor(totalNonBillableMins / 60);
  const nonBillableM = totalNonBillableMins % 60;

  console.log(`  Billable:     ${billableH}h ${billableM}m`);
  console.log(`  Non-billable: ${nonBillableH}h ${nonBillableM}m`);
  console.log(`  Total:        ${Math.floor((totalBillableMins + totalNonBillableMins) / 60)}h ${(totalBillableMins + totalNonBillableMins) % 60}m`);
  console.log("");

  // Token / cost summary
  const totalTokens = inputTokens + outputTokens;
  // Sonnet 4.6 pricing: $3/M input, $15/M output
  const costEstimate = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  console.log(`  Claude API:   ${inputTokens} input + ${outputTokens} output = ${totalTokens} tokens`);
  console.log(`  Est. cost:    $${costEstimate.toFixed(4)}`);
  console.log(`  Match time:   ${(matchDuration / 1000).toFixed(1)}s`);
  console.log(`  Total time:   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log("");
  console.log("=".repeat(70));

  // 5. Ask user
  const answer = await askUser("\nWrite these drafts to Scoro? (y / n / edit): ");

  if (answer === "y") {
    await writeToScoro(events, matches);
  } else if (answer === "edit") {
    console.log("\nEdit mode not yet implemented. Re-run after adjusting mock events.");
  } else {
    console.log("\nAborted. No entries written.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
