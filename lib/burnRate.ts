import type { ProjectData, ScoroTimeEntry } from "./scoro";
import { parseDuration } from "./scoro";
import type { RAGStatus } from "./formatters";
import { getRAGStatus } from "./formatters";

/** Safely coerce a Scoro value (may be string, null, undefined) to number. */
function num(value: unknown): number {
  if (value == null) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

/** Get date from a time entry, trying real Scoro fields then demo fields. */
function getEntryDate(entry: ScoroTimeEntry): string | null {
  return (
    entry.time_entry_date ||
    entry.date ||
    (entry.start_datetime ? entry.start_datetime.substring(0, 10) : null)
  );
}

/** Get hours from a time entry's duration field (handles "HH:MM:SS" strings). */
function getEntryHours(entry: ScoroTimeEntry): number {
  return parseDuration(entry.duration);
}

/** Check if a time entry is billable. */
function isBillable(entry: ScoroTimeEntry): boolean {
  // Scoro uses 0/1, demo data may use true/false or omit (default billable)
  if (entry.is_billable === undefined || entry.is_billable === null) return true;
  return !!entry.is_billable;
}

export interface OverviewSummary {
  totalQuotedHours: number;
  totalLoggedHours: number;
  billableHours: number;
  nonBillableHours: number;
  hoursBurnPercent: number;
  totalQuotedValue: number;
  totalInvoiced: number;
  costBurnPercent: number;
  budget: number;
  budgetRemaining: number;
  hoursBurnRAG: RAGStatus;
  costBurnRAG: RAGStatus;
  hasQuotes: boolean;
  hasInvoices: boolean;
  hasTasks: boolean;
  hasTimeEntries: boolean;
}

export interface TaskBurnRate {
  taskId: number;
  taskName: string;
  activityId?: number;
  quotedHours: number;
  loggedHours: number;
  billableHours: number;
  hoursBurnPercent: number;
  quotedValue: number;
  actualCost: number;
  costBurnPercent: number;
  rag: RAGStatus;
  timeEntries: {
    userName: string;
    date: string;
    duration: number;
    billable: boolean;
    description?: string;
  }[];
}

export interface PersonBurnRate {
  userId: number;
  personName: string;
  totalHours: number;
  billableHours: number;
  totalCost: number;
  tasksWorkedOn: string[];
  avgBurnRate: number;
  rag: RAGStatus;
  taskEntries: {
    taskName: string;
    hours: number;
    cost: number;
  }[];
}

export interface MonthlyBurnRate {
  month: string;
  monthlyHours: number;
  monthlyBillableHours: number;
  cumulativeHours: number;
  cumulativeQuoted: number;
  monthlyBurnPercent: number;
  monthlyInvoiced: number;
  cumulativeInvoiced: number;
  rag: RAGStatus;
}

export function calculateOverview(data: ProjectData): OverviewSummary {
  const { timeEntries, quotes, invoices, project } = data;

  if (timeEntries.length > 0) {
    console.log("[burnRate] First time entry:", JSON.stringify(timeEntries[0], null, 2));
  }

  const totalLoggedHours = timeEntries.reduce(
    (sum, e) => sum + getEntryHours(e),
    0
  );

  const billableHours = timeEntries
    .filter(isBillable)
    .reduce((sum, e) => sum + getEntryHours(e), 0);
  const nonBillableHours = totalLoggedHours - billableHours;

  let totalQuotedHours = 0;
  let totalQuotedValue = 0;
  for (const quote of quotes) {
    const lines = quote.lines || [];
    if (lines.length > 0) {
      for (const line of lines) {
        totalQuotedHours += num(line.amount);
        totalQuotedValue += num(line.sum);
      }
    } else if (quote.sum) {
      totalQuotedValue += num(quote.sum);
    }
  }

  // Fallback: if no quoted hours from quote lines, sum task duration_planned
  if (totalQuotedHours === 0) {
    for (const task of data.tasks) {
      totalQuotedHours += parseDuration(task.duration_planned || task.estimated_hours);
    }
  }

  const totalActualCost = timeEntries
    .filter(isBillable)
    .reduce((sum, e) => sum + getEntryHours(e) * num(e.cost_rate), 0);

  const totalInvoiced = invoices.reduce((sum, i) => sum + num(i.sum), 0);

  // Burn rate: billable hours vs quoted hours
  const hoursBurnPercent =
    totalQuotedHours > 0 ? (billableHours / totalQuotedHours) * 100 : 0;
  const costBurnPercent =
    totalQuotedValue > 0 ? (totalActualCost / totalQuotedValue) * 100 : 0;

  const budget = num(project.budget) || totalQuotedValue;
  const budgetRemaining = budget - totalActualCost;

  return {
    totalQuotedHours,
    totalLoggedHours,
    billableHours,
    nonBillableHours,
    hoursBurnPercent,
    totalQuotedValue,
    totalInvoiced,
    costBurnPercent,
    budget,
    budgetRemaining,
    hoursBurnRAG: getRAGStatus(hoursBurnPercent),
    costBurnRAG: getRAGStatus(costBurnPercent),
    hasQuotes: quotes.length > 0,
    hasInvoices: invoices.length > 0,
    hasTasks: data.tasks.length > 0,
    hasTimeEntries: timeEntries.length > 0,
  };
}

export function calculateByTask(data: ProjectData): TaskBurnRate[] {
  const { timeEntries, quotes, tasks } = data;

  // If no tasks exist in the project, return empty — UI will show empty state
  // (Don't fabricate tasks from time entries)

  // Build quote line lookup by name
  const quoteLookup = new Map<
    string,
    { hours: number; value: number }
  >();
  for (const quote of quotes) {
    const lines = quote.lines || [];
    for (const line of lines) {
      const key = line.comment || line.product_name || `line-${line.product_id}`;
      const existing = quoteLookup.get(key) || { hours: 0, value: 0 };
      existing.hours += num(line.amount);
      existing.value += num(line.sum);
      quoteLookup.set(key, existing);
    }
  }

  // Build task map ONLY from actual project tasks
  const taskMap = new Map<
    number,
    {
      taskName: string;
      activityId?: number;
      plannedHours: number;
      loggedHours: number;
      billableHours: number;
      actualCost: number;
      entries: TaskBurnRate["timeEntries"];
    }
  >();

  for (const task of tasks) {
    const taskId = task.event_id || task.task_id || task.activity_id || 0;
    taskMap.set(taskId, {
      taskName: task.event_name,
      activityId: task.activity_id,
      plannedHours: parseDuration(task.duration_planned || task.estimated_hours),
      loggedHours: 0,
      billableHours: 0,
      actualCost: 0,
      entries: [],
    });
  }

  // Track unassigned time entries (can't match to any project task)
  const unassigned = {
    loggedHours: 0,
    billableHours: 0,
    actualCost: 0,
    entries: [] as TaskBurnRate["timeEntries"],
  };

  for (const entry of timeEntries) {
    const matchKey = entry.event_id || entry.activity_id;
    let taskEntry = matchKey ? taskMap.get(matchKey) : undefined;
    // Also try activity_id if event_id didn't match
    if (!taskEntry && entry.activity_id && entry.activity_id !== matchKey) {
      taskEntry = taskMap.get(entry.activity_id);
    }

    const hours = getEntryHours(entry);
    const billable = isBillable(entry);
    const entryRow = {
      userName: entry.user_name || `User ${entry.user_id}`,
      date: getEntryDate(entry) || "unknown",
      duration: hours,
      billable,
      description: entry.description || entry.title || undefined,
    };

    if (taskEntry) {
      taskEntry.loggedHours += hours;
      if (billable) {
        taskEntry.billableHours += hours;
        taskEntry.actualCost += hours * num(entry.cost_rate);
      }
      taskEntry.entries.push(entryRow);
    } else {
      // No matching project task — goes to "Unassigned"
      unassigned.loggedHours += hours;
      if (billable) {
        unassigned.billableHours += hours;
        unassigned.actualCost += hours * num(entry.cost_rate);
      }
      unassigned.entries.push(entryRow);
    }
  }

  const results: TaskBurnRate[] = [];
  for (const [taskId, taskData] of taskMap) {
    const quoteData = quoteLookup.get(taskData.taskName) || {
      hours: 0,
      value: 0,
    };

    // Use quote line hours, fall back to task's duration_planned
    const quotedHours = quoteData.hours > 0 ? quoteData.hours : taskData.plannedHours;

    // Burn rate uses billable hours only
    const hoursBurnPercent =
      quotedHours > 0
        ? (taskData.billableHours / quotedHours) * 100
        : taskData.billableHours > 0
        ? 100
        : 0;
    const costBurnPercent =
      quoteData.value > 0
        ? (taskData.actualCost / quoteData.value) * 100
        : taskData.actualCost > 0
        ? 100
        : 0;

    const worstBurn = Math.max(hoursBurnPercent, costBurnPercent);

    results.push({
      taskId,
      taskName: taskData.taskName,
      activityId: taskData.activityId,
      quotedHours,
      loggedHours: taskData.loggedHours,
      billableHours: taskData.billableHours,
      hoursBurnPercent,
      quotedValue: quoteData.value,
      actualCost: taskData.actualCost,
      costBurnPercent,
      rag: getRAGStatus(worstBurn),
      timeEntries: taskData.entries,
    });
  }

  results.sort((a, b) => {
    const aMax = Math.max(a.hoursBurnPercent, a.costBurnPercent);
    const bMax = Math.max(b.hoursBurnPercent, b.costBurnPercent);
    return bMax - aMax;
  });

  // Add "Unassigned" row at the bottom if there are unmatched time entries
  if (unassigned.entries.length > 0) {
    results.push({
      taskId: -1,
      taskName: "Unassigned",
      quotedHours: 0,
      loggedHours: unassigned.loggedHours,
      billableHours: unassigned.billableHours,
      hoursBurnPercent: unassigned.billableHours > 0 ? 100 : 0,
      quotedValue: 0,
      actualCost: unassigned.actualCost,
      costBurnPercent: unassigned.actualCost > 0 ? 100 : 0,
      rag: unassigned.billableHours > 0 ? "amber" as RAGStatus : "green" as RAGStatus,
      timeEntries: unassigned.entries,
    });
  }

  return results;
}

export function calculateByPerson(data: ProjectData): PersonBurnRate[] {
  const { timeEntries } = data;
  const taskBurnRates = calculateByTask(data);
  const taskBurnMap = new Map<number, number>();
  for (const t of taskBurnRates) {
    taskBurnMap.set(t.taskId, Math.max(t.hoursBurnPercent, t.costBurnPercent));
  }

  const personMap = new Map<
    number,
    {
      personName: string;
      totalHours: number;
      billableHours: number;
      totalCost: number;
      tasksWorkedOn: Set<string>;
      taskEntries: Map<string, { hours: number; cost: number }>;
      burnRates: number[];
    }
  >();

  for (const entry of timeEntries) {
    const userId = entry.user_id;
    let person = personMap.get(userId);
    if (!person) {
      person = {
        personName: entry.user_name || `User ${userId}`,
        totalHours: 0,
        billableHours: 0,
        totalCost: 0,
        tasksWorkedOn: new Set(),
        taskEntries: new Map(),
        burnRates: [],
      };
      personMap.set(userId, person);
    }

    const hours = getEntryHours(entry);
    const billable = isBillable(entry);
    const cost = billable ? hours * num(entry.cost_rate) : 0;
    person.totalHours += hours;
    if (billable) person.billableHours += hours;
    person.totalCost += cost;

    const taskName = entry.activity_name || entry.event_name || `Task ${entry.activity_id}`;
    person.tasksWorkedOn.add(taskName);

    const existing = person.taskEntries.get(taskName) || {
      hours: 0,
      cost: 0,
    };
    existing.hours += hours;
    existing.cost += cost;
    person.taskEntries.set(taskName, existing);

    const matchKey = entry.event_id || entry.activity_id;
    const burnRate = taskBurnMap.get(matchKey) || 0;
    if (burnRate > 0) person.burnRates.push(burnRate);
  }

  return Array.from(personMap.entries()).map(([userId, p]) => {
    const avgBurnRate =
      p.burnRates.length > 0
        ? p.burnRates.reduce((a, b) => a + b, 0) / p.burnRates.length
        : 0;

    return {
      userId,
      personName: p.personName,
      totalHours: p.totalHours,
      billableHours: p.billableHours,
      totalCost: p.totalCost,
      tasksWorkedOn: Array.from(p.tasksWorkedOn),
      avgBurnRate,
      rag: getRAGStatus(avgBurnRate),
      taskEntries: Array.from(p.taskEntries.entries()).map(
        ([taskName, data]) => ({
          taskName,
          hours: data.hours,
          cost: data.cost,
        })
      ),
    };
  });
}

export function calculateMonthly(data: ProjectData): MonthlyBurnRate[] {
  const { timeEntries, quotes, invoices } = data;

  let totalQuotedHours = 0;
  for (const quote of quotes) {
    const lines = quote.lines || [];
    for (const line of lines) {
      totalQuotedHours += num(line.amount);
    }
  }
  // Fallback: if no quoted hours from quote lines, sum task duration_planned
  if (totalQuotedHours === 0) {
    for (const task of data.tasks) {
      totalQuotedHours += parseDuration(task.duration_planned || task.estimated_hours);
    }
  }

  const monthMap = new Map<
    string,
    { hours: number; billableHours: number; invoiced: number }
  >();

  for (const entry of timeEntries) {
    const date = getEntryDate(entry);
    if (!date) continue;
    const month = date.substring(0, 7);
    const existing = monthMap.get(month) || { hours: 0, billableHours: 0, invoiced: 0 };
    const hours = getEntryHours(entry);
    existing.hours += hours;
    if (isBillable(entry)) existing.billableHours += hours;
    monthMap.set(month, existing);
  }

  for (const invoice of invoices) {
    if (invoice.date) {
      const month = invoice.date.substring(0, 7);
      const existing = monthMap.get(month) || { hours: 0, billableHours: 0, invoiced: 0 };
      existing.invoiced += num(invoice.sum);
      monthMap.set(month, existing);
    }
  }

  const sortedMonths = Array.from(monthMap.keys()).sort();

  let cumulativeHours = 0;
  let cumulativeInvoiced = 0;

  return sortedMonths.map((month) => {
    const monthData = monthMap.get(month)!;
    cumulativeHours += monthData.billableHours;
    cumulativeInvoiced += monthData.invoiced;

    const monthlyBurnPercent =
      totalQuotedHours > 0 ? (cumulativeHours / totalQuotedHours) * 100 : 0;

    return {
      month,
      monthlyHours: monthData.hours,
      monthlyBillableHours: monthData.billableHours,
      cumulativeHours,
      cumulativeQuoted: totalQuotedHours,
      monthlyBurnPercent,
      monthlyInvoiced: monthData.invoiced,
      cumulativeInvoiced,
      rag: getRAGStatus(monthlyBurnPercent),
    };
  });
}
