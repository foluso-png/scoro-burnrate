"use client";

import { useState, useCallback, useEffect } from "react";
import type { ScoroProject, ProjectData } from "@/lib/scoro";
import { fetchProjectData } from "@/lib/scoro";
import { demoProjectData } from "@/lib/demoData";
import {
  calculateOverview,
  calculateByTask,
  calculateByPerson,
  calculateMonthly,
} from "@/lib/burnRate";
import ProjectSearch from "@/components/ProjectSearch";
import DateRangePicker from "@/components/DateRangePicker";
import DemoToggle from "@/components/DemoToggle";
import DashboardTabs from "@/components/DashboardTabs";
import OverviewTab from "@/components/OverviewTab";
import TaskTab from "@/components/TaskTab";
import PersonTab from "@/components/PersonTab";
import MonthlyTab from "@/components/MonthlyTab";
import LoadingSkeleton from "@/components/LoadingSkeleton";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

export default function Home() {
  const [demoMode, setDemoMode] = useState(true);
  const [selectedProject, setSelectedProject] = useState<ScoroProject | null>(
    null
  );
  const [dateFrom, setDateFrom] = useState("2025-10-01");
  const [dateTo, setDateTo] = useState(todayISO());
  const [projectData, setProjectData] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (demoMode) {
      setConnected(null);
      return;
    }
    fetch("/api/scoro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "/projects/list", payload: { per_page: 1 } }),
    })
      .then((res) => setConnected(res.ok))
      .catch(() => setConnected(false));
  }, [demoMode]);

  const loadData = useCallback(
    async (project: ScoroProject, from: string, to: string) => {
      if (demoMode) {
        setProjectData(demoProjectData);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await fetchProjectData(project.project_id, from, to);
        setProjectData(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load project data"
        );
        setProjectData(null);
      } finally {
        setLoading(false);
      }
    },
    [demoMode]
  );

  function handleProjectSelect(project: ScoroProject) {
    setSelectedProject(project);
    const from = project.date || project.start_date || "2025-01-01";
    setDateFrom(from);
    loadData(project, from, dateTo);
  }

  function handleDateChange(from: string, to: string) {
    setDateFrom(from);
    setDateTo(to);
    if (selectedProject) {
      loadData(selectedProject, from, to);
    }
  }

  function handleDemoToggle(enabled: boolean) {
    setDemoMode(enabled);
    setProjectData(null);
    setSelectedProject(null);
    setError(null);
    if (enabled) {
      setProjectData(demoProjectData);
      setDateFrom("2025-10-01");
    }
  }

  useEffect(() => {
    if (demoMode && !projectData) {
      setProjectData(demoProjectData);
    }
  }, [demoMode, projectData]);

  const summary = projectData ? calculateOverview(projectData) : null;
  const taskData = projectData ? calculateByTask(projectData) : null;
  const personData = projectData ? calculateByPerson(projectData) : null;
  const monthlyData = projectData ? calculateMonthly(projectData) : null;

  return (
    <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">
                Burn Rate Dashboard
              </h1>
              {projectData && (
                <p className="mt-1 text-sm text-muted">
                  {projectData.project.project_name}
                  {projectData.project.company_name &&
                    ` — ${projectData.project.company_name}`}
                </p>
              )}
            </div>
            <div className="flex items-center gap-4">
              {connected !== null && !demoMode && (
                <span
                  className={`flex items-center gap-1.5 text-xs ${
                    connected ? "text-emerald-500" : "text-red-500"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      connected ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  {connected ? "Connected" : "Disconnected"}
                </span>
              )}
              <DemoToggle enabled={demoMode} onToggle={handleDemoToggle} />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
            <ProjectSearch
              onSelect={handleProjectSelect}
              demoMode={demoMode}
            />
            <DateRangePicker
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={handleDateChange}
            />
          </div>
        </div>

        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && <LoadingSkeleton />}

        {/* Dashboard content */}
        {!loading && summary && taskData && personData && monthlyData && (
          <DashboardTabs>
            {{
              overview: (
                <OverviewTab summary={summary} />
              ),
              task: <TaskTab tasks={taskData} />,
              person: <PersonTab people={personData} />,
              monthly: <MonthlyTab months={monthlyData} />,
            }}
          </DashboardTabs>
        )}

        {/* Empty state */}
        {!loading && !projectData && !error && !demoMode && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <h2 className="mt-4 text-lg font-semibold text-card-foreground">
              No project selected
            </h2>
            <p className="mt-2 max-w-md text-sm text-muted">
              Search for a project above to view its burn rate data, or enable
              demo mode to explore with sample data.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
