"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { MonthlyBurnRate } from "@/lib/burnRate";
import { formatCurrency, formatHours, formatPercent } from "@/lib/formatters";
import RAGBadge from "./RAGBadge";

interface MonthlyTabProps {
  months: MonthlyBurnRate[];
}

const ragCellClass = {
  green: "",
  amber: "bg-amber-50 dark:bg-amber-900/20",
  red: "bg-red-50 dark:bg-red-900/20",
};

export default function MonthlyTab({ months }: MonthlyTabProps) {
  if (months.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-center">
        <h3 className="text-lg font-semibold text-card-foreground">
          No monthly data available
        </h3>
        <p className="mt-2 max-w-md text-sm text-muted">
          No time entries or invoices found in the selected date range.
        </p>
      </div>
    );
  }

  const chartData = months.map((m) => ({
    month: m.month,
    "Cumulative Logged": m.cumulativeHours,
    "Cumulative Quoted": m.cumulativeQuoted,
  }));

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="px-4 py-3 text-left font-semibold text-card-foreground">
                Month
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Billable Hrs
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Cumul. Hrs
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Cumul. Quoted
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Burn %
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Monthly Invoiced
              </th>
              <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                Cumul. Invoiced
              </th>
              <th className="px-4 py-3 text-center font-semibold text-card-foreground">
                RAG
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr
                key={m.month}
                className={`border-b border-border/50 ${ragCellClass[m.rag]}`}
              >
                <td className="px-4 py-3 font-medium text-card-foreground">
                  {m.month}
                </td>
                <td className="px-4 py-3 text-right text-card-foreground">
                  {formatHours(m.monthlyBillableHours)}
                  {m.monthlyHours !== m.monthlyBillableHours && (
                    <span className="ml-1 text-xs text-muted">
                      ({formatHours(m.monthlyHours)} total)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-card-foreground">
                  {formatHours(m.cumulativeHours)}
                </td>
                <td className="px-4 py-3 text-right text-muted">
                  {formatHours(m.cumulativeQuoted)}
                </td>
                <td className="px-4 py-3 text-right text-card-foreground">
                  {formatPercent(m.monthlyBurnPercent)}
                </td>
                <td className="px-4 py-3 text-right text-card-foreground">
                  {formatCurrency(m.monthlyInvoiced)}
                </td>
                <td className="px-4 py-3 text-right text-card-foreground">
                  {formatCurrency(m.cumulativeInvoiced)}
                </td>
                <td className="px-4 py-3 text-center">
                  <RAGBadge status={m.rag} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="mb-4 text-sm font-semibold text-card-foreground">
          Cumulative Hours: Logged vs Quoted
        </h3>
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="month"
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
              formatter={(value) => formatHours(Number(value))}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="Cumulative Quoted"
              stroke="#94a3b8"
              strokeWidth={2}
              strokeDasharray="8 4"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="Cumulative Logged"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 4, fill: "#3b82f6" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
