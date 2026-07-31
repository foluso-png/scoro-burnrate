"use client";

import { useState } from "react";

// Standard Campfire agency roles. Update this list as roles change.
const ROLES = [
  "Account Director",
  "Senior Account Director",
  "Associate Account Director",
  "Account Manager",
  "Senior Account Manager",
  "Account Executive",
  "Creative Director",
  "Senior Creative",
  "Creative",
  "Designer",
  "Copywriter",
  "Project Manager",
  "Senior Project Manager",
  "Producer",
  "Social Media Manager",
  "Content Creator",
  "Strategist",
  "Data Analyst",
];

export default function RoleSelector({ slackId }: { slackId: string }) {
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

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
        htmlFor="role-select"
      >
        What&apos;s your role?
      </label>
      <p className="text-xs" style={{ color: "#8A7968" }}>
        This helps the bot pick the right task on each project. You can skip
        this and set it later.
      </p>
      <select
        id="role-select"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="rounded-lg px-3 py-2 text-sm"
        style={{
          backgroundColor: "#2A1D14",
          border: "1px solid #3D2B1E",
          color: "#FDF6EC",
        }}
      >
        <option value="">Select your role...</option>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
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
