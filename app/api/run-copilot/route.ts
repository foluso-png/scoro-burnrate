// Required env vars:
//   CRON_SECRET            - Bearer token for authenticating cron requests
//   SLACK_USER_ID          - Slack user ID (single-user for now)
//
// All other env vars (Scoro, Google, Anthropic, Upstash, Slack) are used
// by the shared copilot-summary module.

import { NextRequest, NextResponse } from "next/server";
import { runCopilotSummary } from "@/lib/copilot-summary";

// ---------------------------------------------------------------------------
// GET handler — triggered by Vercel Cron
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const slackId = process.env.SLACK_USER_ID!;

    const result = await runCopilotSummary(slackId, {
      writeToScoro: true,
    });

    return NextResponse.json({
      message:
        result.eventCount === 0
          ? "No events today"
          : `Processed ${result.eventCount} events`,
      matched: result.matched,
      failed: result.failed,
      skipped: result.skipped,
      slack_result: result.slackStatus,
      written: result.written,
      skippedEvents: result.skippedEvents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("run-copilot error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
