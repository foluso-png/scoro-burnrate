// Required env vars:
//   CRON_SECRET            - Bearer token for authenticating cron requests
//
// All other env vars (Scoro, Google, Anthropic, Upstash, Slack) are used
// by the shared copilot-summary module.

import { NextRequest, NextResponse } from "next/server";
import { runCopilotSummary, SummaryResult } from "@/lib/copilot-summary";
import { listRegisteredUsers } from "@/lib/google-auth";
import { getProjectLookup } from "@/lib/matcher";
import { saveLastRun } from "@/lib/last-run";
import { loadUserPrefs, todayLondon } from "@/lib/user-prefs";

// ---------------------------------------------------------------------------
// Per-user result shape for the JSON response
// ---------------------------------------------------------------------------
interface UserRunResult {
  slackId: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  eventCount?: number;
  matched?: number;
  failed?: number;
  skipped?: number;
  slackStatus?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GET handler — triggered by Vercel Cron (hourly, Mon-Fri)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Current hour in Europe/London
  const nowLondon = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const currentHour = nowLondon.getHours();

  const todayStr = todayLondon();

  // 1. Discover all registered users
  const userIds = await listRegisteredUsers();

  if (userIds.length === 0) {
    return NextResponse.json({
      message: "No registered users found",
      hour: currentHour,
      users: [],
    });
  }

  // 2. Filter to users whose delivery hour matches now and who aren't paused
  const eligible: string[] = [];
  const skippedResults: UserRunResult[] = [];

  for (const slackId of userIds) {
    const prefs = await loadUserPrefs(slackId);
    if (prefs.paused) {
      skippedResults.push({ slackId, status: "skipped", reason: "paused" });
      continue;
    }
    if (prefs.deliveryHour !== currentHour) {
      skippedResults.push({
        slackId,
        status: "skipped",
        reason: `hour mismatch (wants ${prefs.deliveryHour}, now ${currentHour})`,
      });
      continue;
    }
    if (prefs.lastSummarySentDate === todayStr) {
      skippedResults.push({
        slackId,
        status: "skipped",
        reason: "already sent today",
      });
      continue;
    }
    eligible.push(slackId);
  }

  if (eligible.length === 0) {
    return NextResponse.json({
      message: `No users due at hour ${currentHour}`,
      hour: currentHour,
      users: skippedResults,
    });
  }

  // 3. Fetch project lookup once for all users
  const projectLookup = await getProjectLookup();

  // 4. Process each eligible user independently
  const results: UserRunResult[] = [...skippedResults];

  for (const slackId of eligible) {
    try {
      const result: SummaryResult = await runCopilotSummary(slackId, {
        writeToScoro: true,
        projectLookup,
      });

      await saveLastRun(slackId, {
        timestamp: new Date().toISOString(),
        status: "ok",
        entryCount: result.matched,
      });

      results.push({
        slackId,
        status: "ok",
        eventCount: result.eventCount,
        matched: result.matched,
        failed: result.failed,
        skipped: result.skipped,
        slackStatus: result.slackStatus,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`run-copilot: user ${slackId} failed:`, message);

      await saveLastRun(slackId, {
        timestamp: new Date().toISOString(),
        status: "error",
        entryCount: 0,
        error: message,
      }).catch(() => {}); // don't let logging fail the loop

      results.push({
        slackId,
        status: "error",
        error: message,
      });
    }
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  const errored = results.filter((r) => r.status === "error").length;

  return NextResponse.json({
    message: `Hour ${currentHour}: ${eligible.length} eligible, ${succeeded} ok, ${errored} failed`,
    hour: currentHour,
    users: results,
  });
}
