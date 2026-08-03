"use client";

import { useState, useRef, useEffect } from "react";
import { CAMPFIRE_ROLES } from "@/lib/roles";

export default function RoleSelector({ slackId }: { slackId: string }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = query
    ? CAMPFIRE_ROLES.filter((r) =>
        r.toLowerCase().includes(query.toLowerCase())
      )
    : [...CAMPFIRE_ROLES];

  // Close dropdown on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    try {
      await fetch("/api/user-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackId, defaultRole: selected }),
      });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <p className="text-sm" style={{ color: "#C9B8A8" }}>
        Role set to <strong style={{ color: "#FDF6EC" }}>{selected}</strong>.
        The bot will use this when matching your tasks.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-left">
      <label
        className="text-sm font-medium"
        style={{ color: "#FDF6EC" }}
        htmlFor="role-search"
      >
        What&apos;s your role?
      </label>
      <p className="text-xs" style={{ color: "#8A7968" }}>
        This helps the bot pick the right task on each project. You can skip
        this and set it later.
      </p>

      {/* Searchable combobox */}
      <div ref={wrapperRef} className="relative">
        <input
          id="role-search"
          type="text"
          value={selected || query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected("");
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Type to search roles..."
          autoComplete="off"
          className="w-full rounded-lg px-3 py-2 text-sm"
          style={{
            backgroundColor: "#2A1D14",
            border: "1px solid #3D2B1E",
            color: "#FDF6EC",
          }}
        />
        {open && filtered.length > 0 && (
          <ul
            className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg py-1"
            style={{
              backgroundColor: "#2A1D14",
              border: "1px solid #3D2B1E",
            }}
          >
            {filtered.map((role) => (
              <li key={role}>
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm transition-colors"
                  style={{
                    color: role === selected ? "#FDF6EC" : "#C9B8A8",
                    backgroundColor:
                      role === selected ? "#3D2B1E" : "transparent",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor = "#3D2B1E")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor =
                      role === selected ? "#3D2B1E" : "transparent")
                  }
                  onClick={() => {
                    setSelected(role);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  {role}
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && query && filtered.length === 0 && (
          <div
            className="absolute z-10 mt-1 w-full rounded-lg px-3 py-2 text-sm"
            style={{
              backgroundColor: "#2A1D14",
              border: "1px solid #3D2B1E",
              color: "#8A7968",
            }}
          >
            No matching roles
          </div>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={!selected || saving}
        className="cf-btn-ember px-4 py-2 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save role"}
      </button>
    </div>
  );
}
