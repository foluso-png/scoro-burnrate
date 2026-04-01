"use client";

import type { RAGStatus } from "@/lib/formatters";
import RAGBadge from "./RAGBadge";

interface SummaryCardProps {
  title: string;
  value: string;
  subtitle?: string;
  rag?: RAGStatus;
}

export default function SummaryCard({
  title,
  value,
  subtitle,
  rag,
}: SummaryCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted">{title}</p>
        {rag && <RAGBadge status={rag} />}
      </div>
      <p className="mt-2 text-2xl font-bold text-card-foreground">{value}</p>
      {subtitle && (
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
      )}
    </div>
  );
}
