export interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
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

export interface ScoroProject {
  project_id: number;
  project_name: string;
  company_name?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  budget?: number;
  budget_type?: string;
  description?: string;
}

export interface ScoroTimeEntry {
  event_id: number;
  activity_id: number;
  activity_name?: string;
  user_id: number;
  user_name?: string;
  duration: number;
  date: string;
  project_id: number;
  bill_rate?: number;
  cost_rate?: number;
  description?: string;
}

export interface ScoroQuote {
  quote_id: number;
  no?: string;
  lines?: ScoroQuoteLine[];
  sum?: number;
  vat_sum?: number;
  discount?: number;
  project_id?: number;
}

export interface ScoroQuoteLine {
  product_id?: number;
  product_name?: string;
  comment?: string;
  amount: number;
  price: number;
  sum: number;
  activity_id?: number;
}

export interface ScoroInvoice {
  invoice_id: number;
  no?: string;
  sum?: number;
  vat_sum?: number;
  date?: string;
  project_id?: number;
  lines?: ScoroQuoteLine[];
}

export interface ScoroTask {
  task_id: number;
  activity_id?: number;
  event_name: string;
  project_id: number;
  status?: string;
  estimated_hours?: number;
}

let projectsCache: ScoroProject[] | null = null;

export async function loadAllProjects(): Promise<ScoroProject[]> {
  if (projectsCache) return projectsCache;
  const response = await scoroFetch<ScoroProject[]>("/projects/list", {
    per_page: 500,
    page: 1,
  });
  projectsCache = response.data || [];
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
  const [project, timeEntries, quotes, invoices, tasks] = await Promise.all([
    getProjectDetails(projectId),
    getTimeEntries(projectId, dateFrom, dateTo),
    getQuotes(projectId),
    getInvoices(projectId),
    getTasks(projectId),
  ]);

  return { project, timeEntries, quotes, invoices, tasks };
}
