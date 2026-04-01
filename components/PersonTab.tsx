"use client";

import { useState, Fragment } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { PersonBurnRate } from "@/lib/burnRate";
import { formatCurrency, formatHours, formatPercent } from "@/lib/formatters";
import RAGBadge from "./RAGBadge";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#f97316"];

interface PersonTabProps {
  people: PersonBurnRate[];
}

export default function PersonTab({ people }: PersonTabProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (people.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-center">
        <h3 className="text-lg font-semibold text-card-foreground">
          No time entries found
        </h3>
        <p className="mt-2 max-w-md text-sm text-muted">
          No one has logged time on this project in the selected date range.
        </p>
      </div>
    );
  }

  const pieData = people.map((p) => ({
    name: p.personName,
    value: p.totalHours,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-card">
                <th className="px-4 py-3 text-left font-semibold text-card-foreground">
                  Person
                </th>
                <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                  Billable Hours
                </th>
                <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                  Total Cost
                </th>
                <th className="px-4 py-3 text-left font-semibold text-card-foreground">
                  Tasks Worked On
                </th>
                <th className="px-4 py-3 text-right font-semibold text-card-foreground">
                  Avg Burn Rate
                </th>
                <th className="px-4 py-3 text-center font-semibold text-card-foreground">
                  RAG
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <Fragment key={person.userId}>
                  <tr
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-border/20"
                    onClick={() =>
                      setExpandedId(
                        expandedId === person.userId ? null : person.userId
                      )
                    }
                  >
                    <td className="px-4 py-3 font-medium text-card-foreground">
                      <span className="mr-2 text-xs text-muted">
                        {expandedId === person.userId ? "v" : ">"}
                      </span>
                      {person.personName}
                    </td>
                    <td className="px-4 py-3 text-right text-card-foreground">
                      {formatHours(person.billableHours)}
                      {person.totalHours !== person.billableHours && (
                        <span className="ml-1 text-xs text-muted">
                          ({formatHours(person.totalHours)} total)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-card-foreground">
                      {formatCurrency(person.totalCost)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {person.tasksWorkedOn.length} tasks
                    </td>
                    <td className="px-4 py-3 text-right text-card-foreground">
                      {formatPercent(person.avgBurnRate)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <RAGBadge status={person.rag} />
                    </td>
                  </tr>
                  {expandedId === person.userId && (
                    <tr key={`${person.userId}-expanded`}>
                      <td colSpan={6} className="bg-border/10 px-8 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted">
                              <th className="pb-2 text-left">Task</th>
                              <th className="pb-2 text-right">Hours</th>
                              <th className="pb-2 text-right">Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {person.taskEntries.map((entry, idx) => (
                              <tr
                                key={idx}
                                className="border-t border-border/30"
                              >
                                <td className="py-1.5 text-card-foreground">
                                  {entry.taskName}
                                </td>
                                <td className="py-1.5 text-right text-card-foreground">
                                  {formatHours(entry.hours)}
                                </td>
                                <td className="py-1.5 text-right text-card-foreground">
                                  {formatCurrency(entry.cost)}
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
            Hours Distribution by Person
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                label={({ name, percent }) =>
                  `${(name ?? "").toString().split(" ")[0]} ${Math.round((percent ?? 0) * 100)}%`
                }
                labelLine={false}
              >
                {pieData.map((_, index) => (
                  <Cell
                    key={index}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  color: "var(--color-card-foreground)",
                }}
                formatter={(value) => `${formatHours(Number(value))} hrs`}
              />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
