"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { OverviewSummary, TaskBurnRate } from "@/lib/burnRate";
import { formatCurrency, formatHours, formatPercent } from "@/lib/formatters";
import SummaryCard from "./SummaryCard";

interface OverviewTabProps {
  summary: OverviewSummary;
  taskData: TaskBurnRate[];
}

export default function OverviewTab({ summary, taskData }: OverviewTabProps) {
  const chartData = taskData.slice(0, 10).map((t) => ({
    name: t.taskName.length > 20 ? t.taskName.slice(0, 18) + "..." : t.taskName,
    "Quoted Hours": t.quotedHours,
    "Actual Hours": t.loggedHours,
  }));

  const costChartData = taskData.slice(0, 10).map((t) => ({
    name: t.taskName.length > 20 ? t.taskName.slice(0, 18) + "..." : t.taskName,
    "Quoted Value": t.quotedValue,
    "Actual Cost": t.actualCost,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          title="Total Quoted Hours"
          value={formatHours(summary.totalQuotedHours)}
        />
        <SummaryCard
          title="Total Logged Hours"
          value={formatHours(summary.totalLoggedHours)}
        />
        <SummaryCard
          title="Hours Burn %"
          value={formatPercent(summary.hoursBurnPercent)}
          rag={summary.hoursBurnRAG}
        />
        <SummaryCard
          title="Total Quoted Value"
          value={formatCurrency(summary.totalQuotedValue)}
        />
        <SummaryCard
          title="Total Invoiced"
          value={formatCurrency(summary.totalInvoiced)}
        />
        <SummaryCard
          title="Cost Burn %"
          value={formatPercent(summary.costBurnPercent)}
          rag={summary.costBurnRAG}
        />
        <SummaryCard
          title="Budget"
          value={formatCurrency(summary.budget)}
        />
        <SummaryCard
          title="Budget Remaining"
          value={formatCurrency(summary.budgetRemaining)}
          rag={summary.budgetRemaining < 0 ? "red" : summary.budgetRemaining < summary.budget * 0.25 ? "amber" : "green"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-sm font-semibold text-card-foreground">
            Hours: Quoted vs Actual
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: "var(--color-muted)" }}
                angle={-30}
                textAnchor="end"
                height={80}
              />
              <YAxis tick={{ fontSize: 12, fill: "var(--color-muted)" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  color: "var(--color-card-foreground)",
                }}
              />
              <Legend />
              <Bar dataKey="Quoted Hours" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Actual Hours" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-sm font-semibold text-card-foreground">
            Cost: Quoted vs Actual
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={costChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: "var(--color-muted)" }}
                angle={-30}
                textAnchor="end"
                height={80}
              />
              <YAxis tick={{ fontSize: 12, fill: "var(--color-muted)" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  color: "var(--color-card-foreground)",
                }}
                formatter={(value) => formatCurrency(Number(value))}
              />
              <Legend />
              <Bar dataKey="Quoted Value" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Actual Cost" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
