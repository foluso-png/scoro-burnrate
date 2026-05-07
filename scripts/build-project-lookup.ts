import * as fs from "fs";
import * as path from "path";

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

const SCORO_SUBDOMAIN = process.env.SCORO_SUBDOMAIN;
const SCORO_API_KEY = process.env.SCORO_API_KEY;
const SCORO_ACCOUNT_ID = process.env.SCORO_ACCOUNT_ID;

if (!SCORO_SUBDOMAIN || !SCORO_API_KEY || !SCORO_ACCOUNT_ID) {
  console.error("Missing required env vars (SCORO_SUBDOMAIN, SCORO_API_KEY, SCORO_ACCOUNT_ID). Check .env.local");
  process.exit(1);
}

const BASE_URL = `https://${SCORO_SUBDOMAIN}.scoro.com/api/v2`;

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
interface ScoroProjectUser {
  id: string;
  email: string;
}

interface ScoroProject {
  project_id: number;
  no?: string;
  project_name?: string;
  name?: string;
  company_id?: number;
  company_name?: string;
  status?: string;
  status_name?: string;
  status_id?: number | string;
  manager_id?: number;
  members?: number[];
  team?: number[];
  assigned_users?: number[];
  project_users?: ScoroProjectUser[];
  date?: string; // start date in Scoro
  start_date?: string;
  end_date?: string;
  deadline?: string;
  is_deleted?: number;
  [key: string]: unknown;
}

interface TaskRecord {
  task_id: number; // Scoro's event_id — used as event_id in time entries
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

// ---------------------------------------------------------------------------
// Fetch all projects with pagination
// ---------------------------------------------------------------------------
async function fetchAllProjects(): Promise<ScoroProject[]> {
  const allProjects: ScoroProject[] = [];
  let page = 1;
  const perPage = 25; // Scoro caps at 25 for detailed_response

  while (true) {
    console.log(`Fetching projects page ${page}...`);
    const res = await scoroPost<ScoroProject[]>("/projects/list", {
      per_page: perPage,
      page,
      detailed_response: true, // request full project objects
    });

    const projects = Array.isArray(res.data) ? res.data : [];
    console.log(`  Page ${page}: ${projects.length} projects`);

    if (projects.length === 0) break;

    allProjects.push(...projects);

    if (projects.length < perPage) break;
    page++;
  }

  return allProjects;
}

// ---------------------------------------------------------------------------
// Fetch tasks for a single project (paginated, deduplicated by name)
// ---------------------------------------------------------------------------
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

  // Keep only active (non-completed) tasks
  const active = allTasks.filter((t) => t.is_completed === 0);

  // Deduplicate by event_name: keep one representative task_id per unique name
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
        assigned_user_ids: t.related_users || (t.assigned_to ? [t.assigned_to] : []),
      });
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Build Project Lookup ===\n");
  console.log(`Subdomain: ${SCORO_SUBDOMAIN}`);
  console.log(`API Key:   ${SCORO_API_KEY!.slice(0, 6)}...`);
  console.log("");

  // Fetch all projects with detail
  const allProjects = await fetchAllProjects();
  console.log(`\nTotal projects fetched: ${allProjects.length}\n`);

  // Log a sample project to understand the shape
  if (allProjects.length > 0) {
    console.log("=== Sample project (first result) ===");
    console.log(JSON.stringify(allProjects[0], null, 2));
    console.log("");
  }

  // Discover all statuses present
  const statusMap = new Map<string, number>();
  for (const p of allProjects) {
    const key = `${p.status_id ?? "null"} (${p.status ?? "unknown"})`;
    statusMap.set(key, (statusMap.get(key) || 0) + 1);
  }

  console.log("=== All statuses found ===");
  for (const [status, count] of [...statusMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }
  console.log("");

  // Extract team user IDs from whichever field is available
  function extractTeam(p: ScoroProject): number[] {
    // Prefer project_users (from detailed response)
    if (Array.isArray(p.project_users) && p.project_users.length > 0) {
      return p.project_users.map((u) => parseInt(u.id, 10)).filter((id) => !isNaN(id));
    }
    if (Array.isArray(p.members) && p.members.length > 0) return p.members;
    if (Array.isArray(p.team) && p.team.length > 0) return p.team;
    if (Array.isArray(p.assigned_users) && p.assigned_users.length > 0) return p.assigned_users;
    return [];
  }

  // Build lookup records for all projects
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
    tasks: [], // populated below for active projects
  }));

  // Fetch tasks for active (in-progress) projects
  const activeRecords = records.filter((r) => r.status === "inprogress");
  console.log(`\nFetching tasks for ${activeRecords.length} active projects...\n`);

  let totalTasksFetched = 0;
  for (let i = 0; i < activeRecords.length; i++) {
    const r = activeRecords[i];
    const tasks = await fetchProjectTasks(r.project_id);
    r.tasks = tasks;
    totalTasksFetched += tasks.length;
    if ((i + 1) % 10 === 0 || i === activeRecords.length - 1) {
      console.log(`  Progress: ${i + 1}/${activeRecords.length} projects, ${totalTasksFetched} unique tasks so far`);
    }
  }
  console.log("");

  // Write to file
  const output = {
    generated_at: new Date().toISOString(),
    project_count: records.length,
    projects: records,
  };

  const outPath = path.resolve(__dirname, "..", "data", "project-lookup.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Written to ${outPath}\n`);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("=== SUMMARY ===\n");
  console.log(`Total projects: ${records.length}`);

  // Breakdown by status
  console.log("\n--- By Status ---");
  const byStatus = new Map<string, number>();
  for (const r of records) {
    const key = r.status;
    byStatus.set(key, (byStatus.get(key) || 0) + 1);
  }
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }

  // Breakdown by client (top 10)
  console.log("\n--- Top 10 Clients by Project Count ---");
  const byClient = new Map<string, number>();
  for (const r of records) {
    const key = r.client_name || "(no client)";
    byClient.set(key, (byClient.get(key) || 0) + 1);
  }
  const sortedClients = [...byClient.entries()].sort((a, b) => b[1] - a[1]);
  for (const [client, count] of sortedClients.slice(0, 10)) {
    console.log(`  ${client}: ${count}`);
  }

  // Data quality flags
  console.log("\n--- Data Quality Flags ---");

  const noClient = records.filter((r) => !r.client_name);
  console.log(`Projects with no client linked: ${noClient.length}`);
  if (noClient.length > 0 && noClient.length <= 20) {
    for (const r of noClient) {
      console.log(`  - [${r.project_id}] ${r.name}`);
    }
  }

  const noTeam = records.filter((r) => r.team_user_ids.length === 0 && !r.manager_id);
  console.log(`Projects with no team and no manager: ${noTeam.length}`);
  if (noTeam.length > 0 && noTeam.length <= 20) {
    for (const r of noTeam) {
      console.log(`  - [${r.project_id}] ${r.name}`);
    }
  }

  const noName = records.filter((r) => !r.name);
  if (noName.length > 0) {
    console.log(`Projects with no name: ${noName.length}`);
    for (const r of noName) {
      console.log(`  - [${r.project_id}]`);
    }
  }

  const noDates = records.filter((r) => !r.start_date && !r.end_date);
  console.log(`Projects with no start or end date: ${noDates.length}`);

  // Task summary
  console.log("\n--- Task Summary (active projects only) ---");
  const taskCounts = activeRecords.map((r) => r.tasks.length);
  const totalTasks = taskCounts.reduce((a, b) => a + b, 0);
  const avgTasks = activeRecords.length > 0 ? (totalTasks / activeRecords.length).toFixed(1) : "0";
  console.log(`Total unique tasks fetched: ${totalTasks}`);
  console.log(`Average tasks per project: ${avgTasks}`);

  const zeroTaskProjects = activeRecords.filter((r) => r.tasks.length === 0);
  console.log(`Active projects with zero tasks: ${zeroTaskProjects.length}`);
  if (zeroTaskProjects.length > 0) {
    for (const r of zeroTaskProjects) {
      console.log(`  - [${r.project_id}] ${r.name} (${r.client_name})`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
