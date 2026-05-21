import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, "..", ".env.local");
const envContent = fs.readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  process.env[key] = value;
}

const SCORO_SUBDOMAIN = process.env.SCORO_SUBDOMAIN;
const SCORO_API_KEY = process.env.SCORO_API_KEY;
const SCORO_ACCOUNT_ID = process.env.SCORO_ACCOUNT_ID;

console.log("=== Environment ===");
console.log(`SCORO_SUBDOMAIN : ${SCORO_SUBDOMAIN}`);
console.log(`SCORO_API_KEY   : ${SCORO_API_KEY ? SCORO_API_KEY.slice(0, 6) + "..." : "NOT SET"}`);
console.log(`SCORO_ACCOUNT_ID: ${SCORO_ACCOUNT_ID}`);
console.log("");

if (!SCORO_SUBDOMAIN || !SCORO_API_KEY || !SCORO_ACCOUNT_ID) {
  console.error("Missing required env vars. Check .env.local");
  process.exit(1);
}

const BASE_URL = `https://${SCORO_SUBDOMAIN}.scoro.com/api/v2`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface ScoroResponse<T = unknown> {
  status: string;
  statusCode: number;
  data: T;
  messages?: { error?: string[] };
}

async function scoroPost<T = unknown>(
  endpoint: string,
  payload: Record<string, unknown> = {}
): Promise<ScoroResponse<T>> {
  const url = `${BASE_URL}${endpoint}`;
  const body = {
    apiKey: SCORO_API_KEY,
    company_account_id: SCORO_ACCOUNT_ID,
    ...payload,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as ScoroResponse<T>;

  if (!res.ok || json.status === "ERROR") {
    const errMsg = json.messages?.error?.join("; ") || `HTTP ${res.status}`;
    throw new Error(`[${res.status}] ${errMsg}`);
  }

  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  // Format as ISO 8601 with timezone offset
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hh = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const mm = String(absOffset % 60).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd}T${hr}:00:00${sign}${hh}:${mm}`;
}

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mo}-${dd}`;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const USER_ID = 107;
const TASK_ID = 23810;

let createdEntryId: number | null = null;
let allPassed = true;
let activityIdRequired = false;
let draftStuck = false;

// ---------------------------------------------------------------------------
// Cleanup: remove leftover test entries from previous runs
// ---------------------------------------------------------------------------
async function cleanupStaleEntries(): Promise<void> {
  console.log("--- CLEANUP: Removing leftover test entries on task 23810 ---");
  const res = await scoroPost<Record<string, unknown>[]>("/timeEntries/list", {
    filter: {
      event_id: TASK_ID,
    },
    per_page: 500,
    page: 1,
  });

  const entries = Array.isArray(res.data) ? res.data : [];
  const stale = entries.filter((e) => {
    const desc = String(e.description || "").toLowerCase();
    return desc.includes("api test") || desc.includes("safe to delete");
  });

  if (stale.length === 0) {
    console.log("No stale test entries found. Clean slate.");
  } else {
    console.log(`Found ${stale.length} stale test entry/entries. Deleting...`);
    for (const entry of stale) {
      const id = (entry.time_entry_id as number) || (entry.id as number);
      try {
        await scoroPost(`/timeEntries/delete/${id}`, {});
        console.log(`  Deleted stale entry ${id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Failed to delete stale entry ${id}: ${msg}`);
      }
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function step1_read(): Promise<number> {
  console.log("--- STEP 1: READ (time entries for user 107, last 7 days) ---");
  const res = await scoroPost<unknown[]>("/timeEntries/list", {
    filter: {
      user_id: USER_ID,
      date_from: dateStr(7),
      date_to: dateStr(0),
    },
    per_page: 500,
    page: 1,
  });
  const count = Array.isArray(res.data) ? res.data.length : 0;
  console.log(`\u2713 STEP 1 PASSED - ${count} time entries found`);
  return count;
}

async function step2_create(): Promise<void> {
  console.log("");
  console.log("--- STEP 2: CREATE time entry ---");

  const payload: Record<string, unknown> = {
    event_id: TASK_ID,
    user_id: USER_ID,
    start_datetime: todayAt(9),
    end_datetime: todayAt(10),
    duration: "01:00:00",
    description: "API test - SAFE TO DELETE",
    is_completed: false,
  };

  console.log("Request payload:", JSON.stringify(payload, null, 2));

  const res = await scoroPost<Record<string, unknown>>("/timeEntries/modify", {
    request: payload,
  });

  console.log("Response:", JSON.stringify(res, null, 2));

  // Extract the new entry ID - Scoro may use time_entry_id or id
  const data = res.data;
  createdEntryId =
    (data.time_entry_id as number) ||
    (data.id as number) ||
    null;

  if (!createdEntryId) {
    throw new Error("Could not extract entry ID from response");
  }

  // Check if is_completed stuck as false (draft)
  if (data.is_completed === false || data.is_completed === 0) {
    draftStuck = true;
  }

  console.log(`\u2713 STEP 2 PASSED - Created entry ID: ${createdEntryId}`);
}

async function step3_modify(): Promise<void> {
  console.log("");
  console.log("--- STEP 3: MODIFY time entry ---");

  const payload: Record<string, unknown> = {
    id: createdEntryId,
    time_entry_id: createdEntryId,
    event_id: TASK_ID,
    user_id: USER_ID,
    description: "API test - modified - SAFE TO DELETE",
  };

  console.log("Request payload:", JSON.stringify(payload, null, 2));

  const res = await scoroPost<Record<string, unknown>>("/timeEntries/modify", {
    request: payload,
  });

  console.log("Response:", JSON.stringify(res, null, 2));
  console.log(`\u2713 STEP 3 PASSED - Modified entry ID: ${createdEntryId}`);
}

async function step4_delete(): Promise<void> {
  console.log("");
  console.log("--- STEP 4: DELETE time entry ---");

  console.log(`Deleting via /timeEntries/delete/${createdEntryId}`);

  const res = await scoroPost<unknown>(`/timeEntries/delete/${createdEntryId}`, {});

  console.log("Response:", JSON.stringify(res, null, 2));
  console.log(`\u2713 STEP 4 PASSED - Deleted entry ID: ${createdEntryId}`);
}

async function step5_verify(originalCount: number): Promise<void> {
  console.log("");
  console.log("--- STEP 5: VERIFY (re-read, confirm cleanup) ---");

  const res = await scoroPost<unknown[]>("/timeEntries/list", {
    filter: {
      user_id: USER_ID,
      date_from: dateStr(7),
      date_to: dateStr(0),
    },
    per_page: 500,
    page: 1,
  });

  const count = Array.isArray(res.data) ? res.data.length : 0;
  console.log(`Entry count before: ${originalCount}, after: ${count}`);

  if (count <= originalCount) {
    console.log("\u2713 STEP 5 PASSED - Cleanup confirmed");
  } else {
    console.log("\u2717 STEP 5 WARNING - Count increased; entry may not have been deleted");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  try {
    // Cleanup stale test entries from previous runs
    await cleanupStaleEntries();

    // Step 1
    const originalCount = await step1_read();

    // Step 2
    try {
      await step2_create();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\u2717 STEP 2 FAILED - ${msg}`);

      // If it mentions activity_id, flag it
      if (msg.toLowerCase().includes("activity")) {
        activityIdRequired = true;
        console.log(">>> activity_id appears to be required. Stopping.");
      }

      allPassed = false;
      printSummary();
      process.exit(1);
    }

    // Pause
    console.log("\nWaiting 5 seconds...");
    await sleep(5000);

    // Step 3
    try {
      await step3_modify();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\u2717 STEP 3 FAILED - ${msg}`);
      console.error(`\n!!! IMPORTANT: Entry ID ${createdEntryId} was CREATED but NOT modified/deleted. Manual cleanup required. !!!`);
      allPassed = false;

      // Still try to delete
      console.log("\nAttempting cleanup (delete) despite modify failure...");
      try {
        await step4_delete();
      } catch (delErr) {
        console.error(`\u2717 CLEANUP ALSO FAILED - Entry ID ${createdEntryId} needs manual deletion`);
      }
      printSummary();
      process.exit(1);
    }

    // Pause
    console.log("\nWaiting 5 seconds...");
    await sleep(5000);

    // Step 4
    try {
      await step4_delete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\u2717 STEP 4 FAILED - ${msg}`);
      console.error(`\n!!! IMPORTANT: Entry ID ${createdEntryId} needs MANUAL DELETION !!!`);
      allPassed = false;
      printSummary();
      process.exit(1);
    }

    // Step 5
    await step5_verify(originalCount);

    printSummary();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n\u2717 FATAL ERROR: ${msg}`);
    if (createdEntryId) {
      console.error(`\n!!! IMPORTANT: Entry ID ${createdEntryId} may need MANUAL DELETION !!!`);
    }
    process.exit(1);
  }
}

function printSummary() {
  console.log("\n=== SUMMARY ===");
  console.log(`All 5 steps passed: ${allPassed ? "YES" : "NO"}`);
  console.log(`activity_id required: ${activityIdRequired ? "YES" : "Not determined (test may not have hit that validation)"}`);
  console.log(`is_completed:false stuck as draft: ${draftStuck ? "YES" : "Not observed / not returned in response"}`);
  if (createdEntryId && !allPassed) {
    console.log(`\n!!! UNDELETED ENTRY ID: ${createdEntryId} !!!`);
  }
}

main();
