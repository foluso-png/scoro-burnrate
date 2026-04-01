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
import type { OverviewSummary } from "@/lib/burnRate";
import { formatCurrency, formatHours, formatPercent } from "@/lib/formatters";
import SummaryCard from "./SummaryCard";

interface OverviewTabProps {
  summary: OverviewSummary;
}

export default function OverviewTab({ summary }: OverviewTabProps) {
  const hoursChartData = [
    {
      name: "Hours",
      Quoted: summary.totalQuotedHours,
      Billable: summary.billableHours,
      "Non-Billable": summary.nonBillableHours,
    },
  ];

  const costChartData = [
    {
      name: "Cost / Value",
      "Quoted Value": summary.totalQuotedValue,
      Invoiced: summary.totalInvoiced,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          title="Quoted Hours"
          value={formatHours(summary.totalQuotedHours)}
          subtitle={!summary.hasQuotes && !summary.hasTasks ? "No quotes or tasks found" : "From quotes / task plans"}
        />
        <SummaryCard
          title="Billable Hours"
          value={formatHours(summary.billableHours)}
          subtitle={summary.hasTimeEntries ? `of ${formatHours(summary.totalLoggedHours)} total logged` : "No time entries found"}
        />
        <SummaryCard
          title="Non-Billable Hours"
          value={formatHours(summary.nonBillableHours)}
        />
        <SummaryCard
          title="Hours Burn Rate"
          value={summary.totalQuotedHours > 0 ? formatPercent(summary.hoursBurnPercent) : "N/A"}
          subtitle={summary.totalQuotedHours > 0
            ? `${formatHours(summary.billableHours)} of ${formatHours(summary.totalQuotedHours)} quoted`
            : "No quoted hours to compare"}
          rag={summary.totalQuotedHours > 0 ? summary.hoursBurnRAG : undefined}
        />
        <SummaryCard
          title="Quoted Value"
          value={formatCurrency(summary.totalQuotedValue)}
          subtitle={!summary.hasQuotes ? "No quotes found" : undefined}
        />
        <SummaryCard
          title="Total Invoiced"
          value={formatCurrency(summary.totalInvoiced)}
          subtitle={!summary.hasInvoices ? "No invoices found" : undefined}
        />
        <SummaryCard
          title="Cost Burn Rate"
          value={summary.totalQuotedValue > 0 ? formatPercent(summary.costBurnPercent) : "N/A"}
          subtitle={summary.totalQuotedValue > 0 ? undefined : "No quoted value to compare"}
          rag={summary.totalQuotedValue > 0 ? summary.costBurnRAG : undefined}
        />
        <SummaryCard
          title="Budget Remaining"
          value={formatCurrency(summary.budgetRemaining)}
          subtitle={`of ${formatCurrency(summary.budget)} budget`}
          rag={summary.budgetRemaining < 0 ? "red" : summary.budgetRemaining < summary.budget * 0.25 ? "amber" : "green"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-sm font-semibold text-card-foreground">
            Hours: Quoted vs Actual
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={hoursChartData} barSize={60}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: "var(--color-muted)" }}
              />
              <YAxis tick={{ fontSize: 12, fill: "var(--color-muted)" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  color: "var(--color-card-foreground)",
                }}
                formatter={(value) => `${Number(value).toFixed(1)} hrs`}
              />
              <Legend />
              <Bar dataKey="Quoted" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Billable" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Non-Billable" fill="#e2e8f0" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-sm font-semibold text-card-foreground">
            Value: Quoted vs Invoiced
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={costChartData} barSize={60}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: "var(--color-muted)" }}
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
              <Bar dataKey="Invoiced" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
