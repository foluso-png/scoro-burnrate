// Required env vars:
//   CRON_SECRET            - Bearer token for authenticating cron requests
//   ADMIN_SLACK_ID         - Slack member ID to alert when the cron fails
//
// All other env vars (Scoro, Google, Anthropic, Upstash, Slack) are used
// by the shared copilot-summary module.

import { NextRequest, NextResponse } from "next/server";
import { runCopilotSummary, SummaryResult } from "@/lib/copilot-summary";
import { listRegisteredUsers } from "@/lib/google-auth";
import { getProjectLookup } from "@/lib/matcher";
import { saveLastRun } from "@/lib/last-run";
import { loadUserPrefs, saveUserPrefs, todayLondon } from "@/lib/user-prefs";
import { PhaseCache } from "@/lib/scoro-phases";

export const maxDuration = 300;

const USER_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Auth failure notification — DM the user, but no more than once per 7 days
// ---------------------------------------------------------------------------
function connectUrl(): string {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "";
  try {
    const u = new URL(redirectUri);
    return `${u.origin}/connect`;
  } catch {
    return "/connect";
  }
}

function daysSince(isoDate: string): number {
  const then = new Date(isoDate + "T00:00:00Z");
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

async function notifyAuthFailure(slackId: string, todayStr: string): Promise<void> {
  const prefs = await loadUserPrefs(slackId);

  if (
    prefs.lastAuthFailureNotified &&
    daysSince(prefs.lastAuthFailureNotified) < 7
  ) {
    return;
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const url = connectUrl();

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: slackId,
      text: `Your Google Calendar connection has expired. You'll keep missing your daily summary until you reconnect: ${url}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Your Google Calendar connection has expired. You'll keep missing your daily summary until you reconnect.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Reconnect", emoji: true },
              url,
              style: "primary",
            },
          ],
        },
      ],
    }),
  });

  prefs.lastAuthFailureNotified = todayStr;
  await saveUserPrefs(slackId, prefs);
}

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

  // 3. Fetch project lookup once for all users (one retry on failure)
  if (!process.env.ADMIN_SLACK_ID) {
    console.error("run-copilot: ADMIN_SLACK_ID is not set — project lookup failures will not be reported to anyone");
  }
  let projectLookup: Awaited<ReturnType<typeof getProjectLookup>>;
  try {
    projectLookup = await getProjectLookup();
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      projectLookup = await getProjectLookup();
    } catch (retryErr) {
      const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.error("run-copilot: getProjectLookup failed after retry:", errMsg);

      // Alert the admin so the outage isn't invisible
      const adminSlackId = process.env.ADMIN_SLACK_ID;
      const slackToken = process.env.SLACK_BOT_TOKEN;
      if (adminSlackId && slackToken) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: adminSlackId,
            text: `Cron failed: could not load the Scoro project list after two attempts. No summaries were sent this hour.\n\nError: ${errMsg}`,
          }),
        }).catch(() => {});
      }

      return NextResponse.json(
        {
          message: `Project lookup failed after retry: ${errMsg}`,
          hour: currentHour,
          eligible: eligible.length,
          users: skippedResults,
        },
        { status: 502 }
      );
    }
  }

  // 4. Process eligible users concurrently with a shared phase cache
  const startMs = Date.now();
  const phaseCache = new PhaseCache();
  const results: UserRunResult[] = [...skippedResults];

  async function processUser(slackId: string): Promise<UserRunResult> {
    try {
      const result: SummaryResult = await runCopilotSummary(slackId, {
        writeToScoro: false,
        projectLookup,
        phaseCache,
        stampEmpty: true,
        silentLeaveSkip: true,
      });

      await saveLastRun(slackId, {
        timestamp: new Date().toISOString(),
        status: "ok",
        entryCount: result.matched,
      });

      return {
        slackId,
        status: "ok",
        eventCount: result.eventCount,
        matched: result.matched,
        failed: result.failed,
        skipped: result.skipped,
        slackStatus: result.slackStatus,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`run-copilot: user ${slackId} failed:`, message);

      await saveLastRun(slackId, {
        timestamp: new Date().toISOString(),
        status: "error",
        entryCount: 0,
        error: message,
      }).catch(() => {});

      const isAuthFailure =
        message.includes("Token refresh failed") ||
        message.includes("Google Calendar is not connected");

      if (isAuthFailure) {
        await notifyAuthFailure(slackId, todayStr).catch((notifyErr) => {
          console.error(`run-copilot: failed to notify ${slackId} about auth failure:`, notifyErr);
        });
      }

      return { slackId, status: "error", error: message };
    }
  }

  // Concurrency-limited pool: run up to USER_CONCURRENCY users at a time.
  // Before dequeuing each user, check elapsed time. If we're past the
  // safety margin, stop early so we can report rather than being killed.
  const BAIL_AFTER_MS = 270_000; // 270s — leave 30s headroom before the 300s timeout
  const queue = [...eligible];
  const skippedByTimeout: string[] = [];
  const running: Promise<void>[] = [];

  async function next(): Promise<void> {
    while (queue.length > 0) {
      if (Date.now() - startMs > BAIL_AFTER_MS) {
        // Drain remaining queue into skippedByTimeout
        skippedByTimeout.push(...queue.splice(0));
        return;
      }
      const slackId = queue.shift()!;
      const result = await processUser(slackId);
      results.push(result);
    }
  }

  for (let i = 0; i < Math.min(USER_CONCURRENCY, queue.length); i++) {
    running.push(next());
  }
  await Promise.all(running);

  // 5. Timing and alerting
  const durationMs = Date.now() - startMs;
  const durationSec = Math.round(durationMs / 1000);
  const succeeded = results.filter((r) => r.status === "ok").length;
  const errored = results.filter((r) => r.status === "error").length;

  console.log(
    `run-copilot: hour ${currentHour}, ${eligible.length} eligible, ${succeeded} ok, ${errored} errors, ${skippedByTimeout.length} timed out, ${durationSec}s`
  );

  if (durationSec > 240) {
    console.warn(
      `run-copilot: run took ${durationSec}s — approaching the 300s timeout`
    );
  }

  if (skippedByTimeout.length > 0) {
    console.error(
      `run-copilot: ran out of time, ${skippedByTimeout.length} users skipped: ${skippedByTimeout.join(", ")}`
    );

    const adminSlackId = process.env.ADMIN_SLACK_ID;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (adminSlackId && slackToken) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: adminSlackId,
          text: `Cron ran out of time: ${skippedByTimeout.length} of ${eligible.length} users didn't get their summary. ${succeeded} ok, ${errored} errors. Run took ${durationSec}s.`,
        }),
      }).catch(() => {});
    }
  }

  return NextResponse.json({
    message: `Hour ${currentHour}: ${eligible.length} eligible, ${succeeded} ok, ${errored} failed, ${skippedByTimeout.length} timed out in ${durationSec}s`,
    hour: currentHour,
    durationSeconds: durationSec,
    users: results,
  });
}
