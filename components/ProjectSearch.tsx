"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { ScoroProject } from "@/lib/scoro";
import { searchProjects } from "@/lib/scoro";
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
  const [results, setResults] = useState<ScoroProject[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(
    async (term: string) => {
      if (!term.trim()) {
        setResults([]);
        return;
      }

      if (demoMode) {
        setResults(
          demoProjects.filter((p) =>
            p.project_name.toLowerCase().includes(term.toLowerCase())
          )
        );
        return;
      }

      setLoading(true);
      try {
        const data = await searchProjects(term);
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [demoMode]
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      doSearch(query);
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, doSearch]);

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
        placeholder="Search projects..."
        className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm text-card-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && (
        <div className="absolute right-3 top-2.5">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-blue-500" />
        </div>
      )}
      {isOpen && results.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
          {results.map((project) => (
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
        </ul>
      )}
      {isOpen && query.trim() && results.length === 0 && !loading && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card p-4 text-center text-sm text-muted shadow-lg">
          No projects found
        </div>
      )}
    </div>
  );
}
