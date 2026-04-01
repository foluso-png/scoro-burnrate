export interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
  page?: number;
  pages?: number;
  per_page?: number;
  total?: number;
}

async function scoroFetch<T = unknown>(
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<ScoroResponse<T>> {
  const res = await fetch("/api/scoro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, payload }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => null);
    throw new Error(
      errorData?.messages?.error?.[0] ||
        `Scoro API error: ${res.status} ${res.statusText}`
    );
  }

  return res.json();
}

/** Parse Scoro duration "HH:MM:SS" to decimal hours. Also handles plain numbers. */
export function parseDuration(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const str = String(value);
  const match = str.match(/^(\d+):(\d+):(\d+)$/);
  if (match) {
    return parseInt(match[1], 10) + parseInt(match[2], 10) / 60 + parseInt(match[3], 10) / 3600;
  }
  const n = Number(str);
  return isNaN(n) ? 0 : n;
}

// Scoro returns project_id for projects list, but "date" as start date and "deadline" as end
export interface ScoroProject {
  project_id: number;
  project_name: string;
  company_name?: string;
  date?: string;       // project start date
  deadline?: string;   // project end date
  start_date?: string; // alias used in demo data
  end_date?: string;   // alias used in demo data
  status?: string;
  budget?: number;
  budget_type?: string;
  description?: string;
}

// Scoro time entry real fields
export interface ScoroTimeEntry {
  time_entry_id?: number;
  event_id?: number;
  activity_id: number;
  user_id: number;
  duration: string | number;           // "HH:MM:SS" or number
  billable_duration?: string | number;
  time_entry_date?: string;            // "YYYY-MM-DD"
  date?: string;                       // fallback/demo
  start_datetime?: string;
  project_id?: number;
  description?: string;
  title?: string;
  event_name?: string;                 // from task reference
  is_billable?: number | boolean;      // 0/1 from Scoro
  is_billed?: number | boolean;
  // These may not exist in real Scoro data but are used in demo
  activity_name?: string;
  user_name?: string;
  bill_rate?: number;
  cost_rate?: number;
}

export interface ScoroQuote {
  id?: number;
  quote_id?: number;  // demo data uses this
  no?: string;
  lines?: ScoroQuoteLine[] | null;
  sum?: number;
  vat_sum?: number;
  discount?: number;
  project_id?: number;
  quote_name?: string;
}

export interface ScoroQuoteLine {
  product_id?: number;
  product_name?: string;
  comment?: string;
  comment2?: string;
  amount: number | string;
  price: number | string;
  sum: number | string;
  activity_id?: number;
  unit?: string;
}

export interface ScoroInvoice {
  id?: number;
  invoice_id?: number;  // demo data uses this
  no?: string;
  sum?: number | string;
  vat_sum?: number | string;
  date?: string;
  project_id?: number;
  lines?: ScoroQuoteLine[] | null;
}

// Scoro task real fields
export interface ScoroTask {
  event_id?: number;
  task_id?: number;    // demo data uses this
  activity_id?: number;
  event_name: string;
  project_id?: number;
  status?: string;
  duration_planned?: string | number;  // "HH:MM:SS"
  duration_actual?: string | number;
  estimated_hours?: number;            // demo data uses this
}

let projectsCache: ScoroProject[] | null = null;

export async function loadAllProjects(): Promise<ScoroProject[]> {
  if (projectsCache) return projectsCache;

  const PER_PAGE = 100;
  let page = 1;
  let allProjects: ScoroProject[] = [];

  // Fetch first page and log pagination info
  const firstResponse = await scoroFetch<ScoroProject[]>("/projects/list", {
    per_page: PER_PAGE,
    page: 1,
  });

  const firstPageData = firstResponse.data || [];
  allProjects = [...firstPageData];

  const totalPages = firstResponse.pages || 1;
  console.log("[loadAllProjects] Pagination info:", {
    page: firstResponse.page,
    pages: firstResponse.pages,
    per_page: firstResponse.per_page,
    total: firstResponse.total,
    firstPageCount: firstPageData.length,
  });

  // Fetch remaining pages
  page = 2;
  while (page <= totalPages) {
    const response = await scoroFetch<ScoroProject[]>("/projects/list", {
      per_page: PER_PAGE,
      page,
    });
    const pageData = response.data || [];
    if (pageData.length === 0) break;
    allProjects = [...allProjects, ...pageData];
    console.log(`[loadAllProjects] Page ${page}/${totalPages}: ${pageData.length} projects`);
    page++;
  }

  // Sort alphabetically by name
  allProjects.sort((a, b) => a.project_name.localeCompare(b.project_name));

  console.log(`[loadAllProjects] Total loaded: ${allProjects.length} projects`);
  projectsCache = allProjects;
  return projectsCache;
}

export function clearProjectsCache() {
  projectsCache = null;
}

export async function searchProjects(
  searchTerm: string
): Promise<ScoroProject[]> {
  const allProjects = await loadAllProjects();
  if (!searchTerm.trim()) return allProjects;
  const term = searchTerm.toLowerCase();
  return allProjects.filter(
    (p) =>
      p.project_name.toLowerCase().includes(term) ||
      (p.company_name && p.company_name.toLowerCase().includes(term))
  );
}

export async function getTimeEntries(
  projectId: number,
  dateFrom: string,
  dateTo: string
): Promise<ScoroTimeEntry[]> {
  const response = await scoroFetch<ScoroTimeEntry[]>("/timeEntries/list", {
    filter: {
      project_id: projectId,
      date_from: dateFrom,
      date_to: dateTo,
    },
    per_page: 500,
    page: 1,
  });
  return response.data || [];
}

export async function getQuotes(projectId: number): Promise<ScoroQuote[]> {
  const response = await scoroFetch<ScoroQuote[]>("/quotes/list", {
    filter: { project_id: projectId },
    per_page: 100,
    page: 1,
  });
  return response.data || [];
}

export async function getInvoices(
  projectId: number
): Promise<ScoroInvoice[]> {
  const response = await scoroFetch<ScoroInvoice[]>("/invoices/list", {
    filter: { project_id: projectId },
    per_page: 100,
    page: 1,
  });
  return response.data || [];
}

export async function getProjectDetails(
  projectId: number
): Promise<ScoroProject> {
  const response = await scoroFetch<ScoroProject>(
    `/projects/view/${projectId}`
  );
  return response.data;
}

export async function getTasks(projectId: number): Promise<ScoroTask[]> {
  const response = await scoroFetch<ScoroTask[]>("/tasks/list", {
    filter: { project_id: projectId },
    per_page: 200,
    page: 1,
  });
  return response.data || [];
}

export interface ScoroUser {
  id: number;
  username?: string;
  firstname?: string;
  lastname?: string;
  full_name?: string;
}

export async function getUsers(): Promise<ScoroUser[]> {
  const response = await scoroFetch<ScoroUser[]>("/users/list", {
    per_page: 500,
    page: 1,
  });
  return response.data || [];
}

export interface ProjectData {
  project: ScoroProject;
  timeEntries: ScoroTimeEntry[];
  quotes: ScoroQuote[];
  invoices: ScoroInvoice[];
  tasks: ScoroTask[];
}

export async function fetchProjectData(
  projectId: number,
  dateFrom: string,
  dateTo: string
): Promise<ProjectData> {
  const [project, timeEntries, quotes, invoices, projectTasks, users] =
    await Promise.all([
      getProjectDetails(projectId),
      getTimeEntries(projectId, dateFrom, dateTo),
      getQuotes(projectId),
      getInvoices(projectId),
      getTasks(projectId),
      getUsers(),
    ]);

  // Log raw task list to see actual Scoro field names
  console.log("[fetchProjectData] Raw project tasks response:", {
    count: projectTasks.length,
    sample: projectTasks.length > 0 ? JSON.stringify(projectTasks[0], null, 2) : "none",
    allTaskIds: projectTasks.map((t) => ({
      event_id: t.event_id,
      task_id: t.task_id,
      activity_id: t.activity_id,
      event_name: t.event_name,
    })),
  });

  // Build task name map ONLY from project tasks — never fetch external tasks
  const taskNameMap = new Map<number, string>();
  for (const t of projectTasks) {
    const id = t.event_id || t.task_id || t.activity_id;
    if (id) taskNameMap.set(id, t.event_name);
  }

  // Build user name lookup
  const userMap = new Map<number, string>();
  for (const u of users) {
    const name =
      u.full_name ||
      [u.firstname, u.lastname].filter(Boolean).join(" ") ||
      u.username ||
      `User ${u.id}`;
    userMap.set(u.id, name);
  }

  // Log summary
  console.log("[fetchProjectData] Data summary:", {
    timeEntries: timeEntries.length,
    projectTasks: projectTasks.length,
    quotes: quotes.length,
    quotesWithLines: quotes.filter((q) => (q.lines || []).length > 0).length,
    invoices: invoices.length,
    users: users.length,
  });
  if (timeEntries.length > 0) {
    console.log("[fetchProjectData] Sample time entry:", JSON.stringify(timeEntries[0], null, 2));
  }
  if (quotes.length > 0) {
    console.log("[fetchProjectData] Sample quote:", JSON.stringify(quotes[0], null, 2));
  }

  // Log unmatched time entries for debugging
  const unmatchedEventIds = new Set<number>();
  for (const entry of timeEntries) {
    const matchId = entry.event_id || entry.activity_id;
    if (matchId && !taskNameMap.has(matchId)) {
      unmatchedEventIds.add(matchId);
    }
  }
  if (unmatchedEventIds.size > 0) {
    console.log(`[fetchProjectData] ${unmatchedEventIds.size} time entry event_ids have no matching project task:`, Array.from(unmatchedEventIds));
  }

  // Enrich time entries with resolved names (only from project tasks)
  const enrichedEntries = timeEntries.map((entry) => {
    const matchId = entry.event_id || entry.activity_id;
    const taskName = matchId ? taskNameMap.get(matchId) : undefined;
    return {
      ...entry,
      user_name: userMap.get(entry.user_id) || `User ${entry.user_id}`,
      activity_name: taskName || undefined, // Don't fabricate names
    };
  });

  return { project, timeEntries: enrichedEntries, quotes, invoices, tasks: projectTasks };
}
