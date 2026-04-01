import type { ProjectData } from "./scoro";
import type { RAGStatus } from "./formatters";
import { getRAGStatus } from "./formatters";

export interface OverviewSummary {
  totalQuotedHours: number;
  totalLoggedHours: number;
  hoursBurnPercent: number;
  totalQuotedValue: number;
  totalInvoiced: number;
  costBurnPercent: number;
  budget: number;
  budgetRemaining: number;
  hoursBurnRAG: RAGStatus;
  costBurnRAG: RAGStatus;
}

export interface TaskBurnRate {
  taskId: number;
  taskName: string;
  activityId?: number;
  quotedHours: number;
  loggedHours: number;
  hoursBurnPercent: number;
  quotedValue: number;
  actualCost: number;
  costBurnPercent: number;
  rag: RAGStatus;
  timeEntries: {
    userName: string;
    date: string;
    duration: number;
    description?: string;
  }[];
}

export interface PersonBurnRate {
  userId: number;
  personName: string;
  totalHours: number;
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
  cumulativeHours: number;
  cumulativeQuoted: number;
  monthlyBurnPercent: number;
  monthlyInvoiced: number;
  cumulativeInvoiced: number;
  rag: RAGStatus;
}

export function calculateOverview(data: ProjectData): OverviewSummary {
  const { timeEntries, quotes, invoices, project } = data;

  const totalLoggedHours = timeEntries.reduce(
    (sum, e) => sum + (e.duration || 0),
    0
  );

  let totalQuotedHours = 0;
  let totalQuotedValue = 0;
  for (const quote of quotes) {
    if (quote.lines) {
      for (const line of quote.lines) {
        totalQuotedHours += line.amount || 0;
        totalQuotedValue += line.sum || 0;
      }
    } else if (quote.sum) {
      totalQuotedValue += quote.sum;
    }
  }

  const totalActualCost = timeEntries.reduce(
    (sum, e) => sum + (e.duration || 0) * (e.cost_rate || 0),
    0
  );

  const totalInvoiced = invoices.reduce((sum, i) => sum + (i.sum || 0), 0);

  const hoursBurnPercent =
    totalQuotedHours > 0 ? (totalLoggedHours / totalQuotedHours) * 100 : 0;
  const costBurnPercent =
    totalQuotedValue > 0 ? (totalActualCost / totalQuotedValue) * 100 : 0;

  const budget = project.budget || totalQuotedValue;
  const budgetRemaining = budget - totalActualCost;

  return {
    totalQuotedHours,
    totalLoggedHours,
    hoursBurnPercent,
    totalQuotedValue,
    totalInvoiced,
    costBurnPercent,
    budget,
    budgetRemaining,
    hoursBurnRAG: getRAGStatus(hoursBurnPercent),
    costBurnRAG: getRAGStatus(costBurnPercent),
  };
}

export function calculateByTask(data: ProjectData): TaskBurnRate[] {
  const { timeEntries, quotes, tasks } = data;

  const quoteLookup = new Map<
    string,
    { hours: number; value: number }
  >();
  for (const quote of quotes) {
    if (quote.lines) {
      for (const line of quote.lines) {
        const key = line.comment || line.product_name || `line-${line.product_id}`;
        const existing = quoteLookup.get(key) || { hours: 0, value: 0 };
        existing.hours += line.amount || 0;
        existing.value += line.sum || 0;
        quoteLookup.set(key, existing);
      }
    }
  }

  const taskMap = new Map<
    number,
    {
      taskName: string;
      activityId?: number;
      loggedHours: number;
      actualCost: number;
      entries: TaskBurnRate["timeEntries"];
    }
  >();

  for (const task of tasks) {
    taskMap.set(task.task_id, {
      taskName: task.event_name,
      activityId: task.activity_id,
      loggedHours: 0,
      actualCost: 0,
      entries: [],
    });
  }

  for (const entry of timeEntries) {
    const activityId = entry.activity_id;
    let taskEntry = taskMap.get(activityId);
    if (!taskEntry) {
      taskEntry = {
        taskName: entry.activity_name || `Task ${activityId}`,
        activityId,
        loggedHours: 0,
        actualCost: 0,
        entries: [],
      };
      taskMap.set(activityId, taskEntry);
    }
    taskEntry.loggedHours += entry.duration || 0;
    taskEntry.actualCost += (entry.duration || 0) * (entry.cost_rate || 0);
    taskEntry.entries.push({
      userName: entry.user_name || `User ${entry.user_id}`,
      date: entry.date,
      duration: entry.duration,
      description: entry.description,
    });
  }

  const results: TaskBurnRate[] = [];
  for (const [taskId, taskData] of taskMap) {
    const quoteData = quoteLookup.get(taskData.taskName) || {
      hours: 0,
      value: 0,
    };

    const hoursBurnPercent =
      quoteData.hours > 0
        ? (taskData.loggedHours / quoteData.hours) * 100
        : taskData.loggedHours > 0
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
      quotedHours: quoteData.hours,
      loggedHours: taskData.loggedHours,
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
        totalCost: 0,
        tasksWorkedOn: new Set(),
        taskEntries: new Map(),
        burnRates: [],
      };
      personMap.set(userId, person);
    }

    const hours = entry.duration || 0;
    const cost = hours * (entry.cost_rate || 0);
    person.totalHours += hours;
    person.totalCost += cost;

    const taskName = entry.activity_name || `Task ${entry.activity_id}`;
    person.tasksWorkedOn.add(taskName);

    const existing = person.taskEntries.get(taskName) || {
      hours: 0,
      cost: 0,
    };
    existing.hours += hours;
    existing.cost += cost;
    person.taskEntries.set(taskName, existing);

    const burnRate = taskBurnMap.get(entry.activity_id) || 0;
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
    if (quote.lines) {
      for (const line of quote.lines) {
        totalQuotedHours += line.amount || 0;
      }
    }
  }

  const monthMap = new Map<
    string,
    { hours: number; invoiced: number }
  >();

  for (const entry of timeEntries) {
    const month = entry.date.substring(0, 7);
    const existing = monthMap.get(month) || { hours: 0, invoiced: 0 };
    existing.hours += entry.duration || 0;
    monthMap.set(month, existing);
  }

  for (const invoice of invoices) {
    if (invoice.date) {
      const month = invoice.date.substring(0, 7);
      const existing = monthMap.get(month) || { hours: 0, invoiced: 0 };
      existing.invoiced += invoice.sum || 0;
      monthMap.set(month, existing);
    }
  }

  const sortedMonths = Array.from(monthMap.keys()).sort();

  let cumulativeHours = 0;
  let cumulativeInvoiced = 0;

  return sortedMonths.map((month) => {
    const data = monthMap.get(month)!;
    cumulativeHours += data.hours;
    cumulativeInvoiced += data.invoiced;

    const monthlyBurnPercent =
      totalQuotedHours > 0 ? (cumulativeHours / totalQuotedHours) * 100 : 0;

    return {
      month,
      monthlyHours: data.hours,
      cumulativeHours,
      cumulativeQuoted: totalQuotedHours,
      monthlyBurnPercent,
      monthlyInvoiced: data.invoiced,
      cumulativeInvoiced,
      rag: getRAGStatus(monthlyBurnPercent),
    };
  });
}
