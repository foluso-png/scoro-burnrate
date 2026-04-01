"use client";

import type { RAGStatus } from "@/lib/formatters";

const colors: Record<RAGStatus, string> = {
  green:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  amber:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export default function RAGBadge({
  status,
  label,
}: {
  status: RAGStatus;
  label?: string;
}) {
  const displayLabel = label || status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${colors[status]}`}
    >
      {displayLabel}
    </span>
  );
}
