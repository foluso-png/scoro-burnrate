"use client";

import { useState, Fragment } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { TaskBurnRate } from "@/lib/burnRate";
import { formatCurrency, formatHours, formatPercent } from "@/lib/formatters";
import RAGBadge from "./RAGBadge";

const RAG_COLORS = {
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
};

type SortField = "hoursBurnPercent" | "costBurnPercent" | "taskName" | "loggedHours";

interface TaskTabProps {
  tasks: TaskBurnRate[];
}

export default function TaskTab({ tasks }: TaskTabProps) {
  const [sortField, setSortField] = useState<SortField>("hoursBurnPercent");
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sorted = [...tasks].sort((a, b) => {
    let aVal: number | string;
    let bVal: number | string;

    if (sortField === "taskName") {
      aVal = a.taskName;
      bVal = b.taskName;
    } else {
      aVal = a[sortField];
      bVal = b[sortField];
    }

    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortAsc
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  }

  const chartData = sorted.slice(0, 15).map((t) => ({
    name: t.taskName.length > 25 ? t.taskName.slice(0, 23) + "..." : t.taskName,
    burnRate: Math.max(t.hoursBurnPercent, t.costBurnPercent),
    rag: t.rag,
  }));

  const SortIcon = ({ field }: { field: SortField }) => (
    <span className="ml-1 text-xs">
      {sortField === field ? (sortAsc ? "^" : "v") : ""}
    </span>
  );

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-center">
        <h3 className="text-lg font-semibold text-card-foreground">
          No tasks found for this project
        </h3>
        <p className="mt-2 max-w-md text-sm text-muted">
          This project has no tasks in Scoro. Tasks need to be created in Scoro
          before they appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-card">
              <th
                className="cursor-pointer px-4 py-3 text-left font-semibold text-card-foreground"
                onClick={() => handleSort("taskName")}
              >
                Task Name
                <SortIcon field="taskName" />
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Quoted Hrs
              </th>
              <th
                className="cursor-pointer px-4 py-3 text-right font-semibold text-card-foreground"
                onClick={() => handleSort("loggedHours")}
              >
                Billable Hrs
                <SortIcon field="loggedHours" />
              </th>
              <th
                className="cursor-pointer px-4 py-3 text-right font-semibold text-card-foreground"
                onClick={() => handleSort("hoursBurnPercent")}
              >
                Hours Burn %
                <SortIcon field="hoursBurnPercent" />
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Quoted Value
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Actual Cost
              </th>
              <th
                className="cursor-pointer px-4 py-3 text-right font-semibold text-card-foreground"
                onClick={() => handleSort("costBurnPercent")}
              >
                Cost Burn %
                <SortIcon field="costBurnPercent" />
              </th>
              <th className="px-4 py-3 text-center font-semibold text-card-foreground">
                RAG
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((task) => (
              <Fragment key={task.taskId}>
                <tr
                  className="cursor-pointer border-b border-border/50 transition-colors hover:bg-border/20"
                  onClick={() =>
                    setExpandedId(
                      expandedId === task.taskId ? null : task.taskId
                    )
                  }
                >
                  <td className="px-4 py-3 font-medium text-card-foreground">
                    <span className="mr-2 text-xs text-muted">
                      {expandedId === task.taskId ? "v" : ">"}
                    </span>
                    {task.taskName}
                  </td>
                  <td className="px-4 py-3 text-right text-muted">
                    {formatHours(task.quotedHours)}
                  </td>
                  <td className="px-4 py-3 text-right text-card-foreground">
                    {formatHours(task.billableHours)}
                    {task.loggedHours !== task.billableHours && (
                      <span className="ml-1 text-xs text-muted">
                        ({formatHours(task.loggedHours)} total)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-card-foreground">
                    {formatPercent(task.hoursBurnPercent)}
                  </td>
                  <td className="px-4 py-3 text-right text-muted">
                    {formatCurrency(task.quotedValue)}
                  </td>
                  <td className="px-4 py-3 text-right text-card-foreground">
                    {formatCurrency(task.actualCost)}
                  </td>
                  <td className="px-4 py-3 text-right text-card-foreground">
                    {formatPercent(task.costBurnPercent)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <RAGBadge status={task.rag} />
                  </td>
                </tr>
                {expandedId === task.taskId && (
                  <tr key={`${task.taskId}-expanded`}>
                    <td colSpan={8} className="bg-border/10 px-8 py-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted">
                            <th className="pb-2 text-left">Person</th>
                            <th className="pb-2 text-left">Date</th>
                            <th className="pb-2 text-right">Hours</th>
                            <th className="pb-2 text-left">Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          {task.timeEntries.map((entry, idx) => (
                            <tr key={idx} className="border-t border-border/30">
                              <td className="py-1.5 text-card-foreground">
                                {entry.userName}
                              </td>
                              <td className="py-1.5 text-muted">
                                {entry.date}
                              </td>
                              <td className="py-1.5 text-right text-card-foreground">
                                {formatHours(entry.duration)}
                              </td>
                              <td className="py-1.5 text-muted">
                                {entry.description || "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold text-card-foreground">
          Tasks Ranked by Burn Rate
        </h3>
        <ResponsiveContainer width="100%" height={Math.max(250, chartData.length * 35)}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 120 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              type="number"
              tick={{ fontSize: 12, fill: "var(--color-muted)" }}
              domain={[0, "auto"]}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: "var(--color-muted)" }}
              width={110}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                color: "var(--color-card-foreground)",
              }}
              formatter={(value) => `${Math.round(Number(value))}%`}
            />
            <Bar dataKey="burnRate" radius={[0, 4, 4, 0]}>
              {chartData.map((entry, index) => (
                <Cell key={index} fill={RAG_COLORS[entry.rag]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
