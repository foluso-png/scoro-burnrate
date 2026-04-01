export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatHours(value: number): string {
  return value.toFixed(1);
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export type RAGStatus = "green" | "amber" | "red";

export function getRAGStatus(burnPercent: number): RAGStatus {
  if (burnPercent > 100) return "red";
  if (burnPercent >= 75) return "amber";
  return "green";
}
