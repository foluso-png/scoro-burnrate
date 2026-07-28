// Cleanup script: find and optionally delete all Co-pilot time entries from Scoro.
//
// Usage:
//   node scripts/cleanup-copilot-entries.js            # dry-run (list only)
//   node scripts/cleanup-copilot-entries.js --confirm   # actually delete
//
// SAFETY: only targets entries whose description contains "[Co-pilot draft]"
// or "[Co-pilot]". Untagged entries are never touched.

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const BASE =
  "https://" + process.env.SCORO_SUBDOMAIN + ".scoro.com/api/v2";
const AUTH = {
  apiKey: process.env.SCORO_API_KEY,
  company_account_id: process.env.SCORO_ACCOUNT_ID,
};

const CONFIRM = process.argv.includes("--confirm");

// ---------------------------------------------------------------------------
// Scoro helpers
// ---------------------------------------------------------------------------
async function scoroPost(endpoint, payload = {}) {
  const res = await fetch(BASE + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...AUTH, ...payload }),
  });
  const json = await res.json();
  if (!res.ok || json.status === "ERROR") {
    const msg =
      (json.messages && json.messages.error && json.messages.error.join("; ")) ||
      "HTTP " + res.status;
    throw new Error("Scoro " + endpoint + ": " + msg);
  }
  return json;
}

function isCopilotEntry(description) {
  if (!description) return false;
  return (
    description.includes("[Co-pilot]") ||
    description.includes("[Co-pilot draft]")
  );
}

function parseDuration(dur) {
  if (!dur) return "0:00";
  const parts = dur.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  return h + "h " + String(m).padStart(2, "0") + "m";
}

// ---------------------------------------------------------------------------
// Fetch all time entries (paginated), filter to co-pilot only
// ---------------------------------------------------------------------------
async function fetchAllCopilotEntries() {
  const all = [];
  let page = 1;

  while (true) {
    const res = await scoroPost("/timeEntries/list", {
      per_page: 100,
      page,
    });
    const entries = Array.isArray(res.data) ? res.data : [];
    if (entries.length === 0) break;

    for (const e of entries) {
      if (isCopilotEntry(e.description)) {
        all.push(e);
      }
    }

    if (entries.length < 100) break;
    page++;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Delete a single entry
// ---------------------------------------------------------------------------
async function deleteEntry(entryId) {
  return scoroPost("/timeEntries/delete/" + entryId, {});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(CONFIRM ? "MODE: DELETE (--confirm)" : "MODE: DRY RUN (pass --confirm to delete)");
  console.log("");

  console.log("Fetching time entries from Scoro...");
  const entries = await fetchAllCopilotEntries();

  if (entries.length === 0) {
    console.log("No co-pilot entries found. Nothing to clean up.");
    return;
  }

  console.log("Found " + entries.length + " co-pilot entries:\n");
  console.log(
    "ID".padEnd(10) +
    "Date".padEnd(14) +
    "Duration".padEnd(12) +
    "Description"
  );
  console.log("-".repeat(70));

  for (const e of entries) {
    const id = String(e.time_entry_id || e.id);
    const date = (e.start_datetime || "").slice(0, 10) || "unknown";
    const dur = parseDuration(e.duration);
    const desc = (e.description || "").slice(0, 80);
    console.log(
      id.padEnd(10) +
      date.padEnd(14) +
      dur.padEnd(12) +
      desc
    );
  }

  console.log("-".repeat(70));
  console.log("Total: " + entries.length + " entries");
  console.log("");

  if (!CONFIRM) {
    console.log("DRY RUN complete. No entries were deleted.");
    console.log("Run with --confirm to delete these entries.");
    return;
  }

  // Actually delete
  console.log("Deleting " + entries.length + " entries...");
  let deleted = 0;
  let failed = 0;

  for (const e of entries) {
    const id = e.time_entry_id || e.id;
    try {
      await deleteEntry(id);
      deleted++;
    } catch (err) {
      console.error("  Failed to delete " + id + ": " + err.message);
      failed++;
    }
  }

  console.log("");
  console.log("Done. Deleted: " + deleted + ", Failed: " + failed);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
