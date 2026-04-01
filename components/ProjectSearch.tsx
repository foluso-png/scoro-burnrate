"use client";

import { useState, useEffect, useRef } from "react";
import type { ScoroProject } from "@/lib/scoro";
import { loadAllProjects, clearProjectsCache } from "@/lib/scoro";
import { demoProjects } from "@/lib/demoData";

interface ProjectSearchProps {
  onSelect: (project: ScoroProject) => void;
  demoMode: boolean;
}

export default function ProjectSearch({
  onSelect,
  demoMode,
}: ProjectSearchProps) {
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState<ScoroProject[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load projects when demo mode changes
  useEffect(() => {
    if (demoMode) {
      setAllProjects(demoProjects);
      return;
    }

    clearProjectsCache();
    setLoading(true);
    loadAllProjects()
      .then((projects) => {
        console.log("[ProjectSearch] Loaded", projects.length, "projects from Scoro");
        setAllProjects(projects);
      })
      .catch((err) => {
        console.error("[ProjectSearch] Failed to load projects:", err);
        setAllProjects([]);
      })
      .finally(() => setLoading(false));
  }, [demoMode]);

  // Filter projects based on query
  const filtered = query.trim()
    ? allProjects.filter((p) => {
        const term = query.toLowerCase();
        return (
          p.project_name.toLowerCase().includes(term) ||
          (p.company_name && p.company_name.toLowerCase().includes(term))
        );
      })
    : allProjects;

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={
          loading
            ? "Loading projects..."
            : `Search ${allProjects.length} projects...`
        }
        className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm text-card-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && (
        <div className="absolute right-3 top-2.5">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-blue-500" />
        </div>
      )}
      {isOpen && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
          {filtered.slice(0, 50).map((project) => (
            <li key={project.project_id}>
              <button
                type="button"
                className="w-full px-4 py-3 text-left text-sm hover:bg-border/30 first:rounded-t-lg last:rounded-b-lg"
                onClick={() => {
                  onSelect(project);
                  setQuery(project.project_name);
                  setIsOpen(false);
                }}
              >
                <span className="font-medium text-card-foreground">
                  {project.project_name}
                </span>
                {project.company_name && (
                  <span className="ml-2 text-muted">
                    — {project.company_name}
                  </span>
                )}
              </button>
            </li>
          ))}
          {filtered.length > 50 && (
            <li className="px-4 py-2 text-center text-xs text-muted">
              {filtered.length - 50} more — type to narrow results
            </li>
          )}
        </ul>
      )}
      {isOpen && query.trim() && filtered.length === 0 && !loading && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card p-4 text-center text-sm text-muted shadow-lg">
          No projects found
        </div>
      )}
    </div>
  );
}
