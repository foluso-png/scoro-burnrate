// Required env vars:
//   CRON_SECRET            - Bearer token for authenticating cron requests
//
// All other env vars (Scoro, Google, Anthropic, Upstash, Slack) are used
// by the shared copilot-summary module.

import { NextRequest, NextResponse } from "next/server";
import { runCopilotSummary, SummaryResult } from "@/lib/copilot-summary";
import { listRegisteredUsers } from "@/lib/google-auth";
import { getProjectLookup } from "@/lib/matcher";

// ---------------------------------------------------------------------------
// Per-user result shape for the JSON response
// ---------------------------------------------------------------------------
interface UserRunResult {
  slackId: string;
  status: "ok" | "error";
  eventCount?: number;
  matched?: number;
  failed?: number;
  skipped?: number;
  slackStatus?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GET handler — triggered by Vercel Cron
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // 1. Discover all registered users
  const userIds = await listRegisteredUsers();

  if (userIds.length === 0) {
    return NextResponse.json({
      message: "No registered users found",
      users: [],
    });
  }

  // 2. Fetch project lookup once for all users
  const projectLookup = await getProjectLookup();

  // 3. Process each user independently — one failure must not block others
  const results: UserRunResult[] = [];

  for (const slackId of userIds) {
    try {
      const result: SummaryResult = await runCopilotSummary(slackId, {
        writeToScoro: true,
        projectLookup,
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
    message: `Processed ${userIds.length} user${userIds.length === 1 ? "" : "s"}: ${succeeded} ok, ${errored} failed`,
    users: results,
  });
}
