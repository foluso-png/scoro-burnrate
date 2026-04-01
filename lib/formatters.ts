function safeNum(value: unknown): number {
  if (value == null) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

export function formatCurrency(value: unknown): string {
  const n = safeNum(value);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function formatHours(value: unknown): string {
  return safeNum(value).toFixed(1);
}

export function formatPercent(value: unknown): string {
  return `${Math.round(safeNum(value))}%`;
}

export type RAGStatus = "green" | "amber" | "red";

export function getRAGStatus(burnPercent: unknown): RAGStatus {
  const n = safeNum(burnPercent);
  if (n > 100) return "red";
  if (n >= 75) return "amber";
  return "green";
}
