"use client";

import { useState } from "react";

type Tab = "overview" | "task" | "person" | "monthly";

const tabs: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "task", label: "By Task" },
  { id: "person", label: "By Person" },
  { id: "monthly", label: "Monthly" },
];

interface DashboardTabsProps {
  children: Record<Tab, React.ReactNode>;
}

export default function DashboardTabs({ children }: DashboardTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  return (
    <div>
      <div className="mb-6 flex gap-1 rounded-lg border border-border bg-card p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-blue-500 text-white shadow-sm"
                : "text-muted hover:text-card-foreground hover:bg-border/30"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div>{children[activeTab]}</div>
    </div>
  );
}
