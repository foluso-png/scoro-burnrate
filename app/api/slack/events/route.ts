// Required env vars:
//   SLACK_SIGNING_SECRET  - for request verification
//   SLACK_BOT_TOKEN       - for posting replies
//   ANTHROPIC_API_KEY     - for AI matching

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  loadConversation,
  saveConversation,
} from "@/lib/conversation";
import { matchEvents, getProjectLookup } from "@/lib/matcher";

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------
function parseDurationMinutes(text: string): number | null {
  // "1.5h", "1.5 hours", "1h30m", "1 hour 30 mins", "90 mins", "2h", "30m"
  const normalized = text.toLowerCase();

  // Try "Xh Ym" or "Xh" or "Ym" patterns
  const hm = normalized.match(
    /(\d+(?:\.\d+)?)\s*h(?:ours?|rs?|r)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?/
  );
  if (hm) {
    const hours = parseFloat(hm[1]);
    const mins = hm[2] ? parseInt(hm[2], 10) : 0;
    return Math.round(hours * 60) + mins;
  }

  // Try standalone minutes: "30 mins", "90 minutes"
  const mOnly = normalized.match(/(\d+)\s*m(?:ins?|inutes?)?/);
  if (mOnly) {
    return parseInt(mOnly[1], 10);
  }

  // Try bare number with "hours": "2 hours"
  const hoursOnly = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  if (hoursOnly) {
    return Math.round(parseFloat(hoursOnly[1]) * 60);
  }

  return null;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ---------------------------------------------------------------------------
// Slack message posting
// ---------------------------------------------------------------------------
async function postSlackReply(
  channel: string,
  blocks: Record<string, unknown>[],
  text: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, blocks }),
  });
}

// ---------------------------------------------------------------------------
// Handle free-text message when user is in "editing" step
// ---------------------------------------------------------------------------
async function handleFreeTextEntry(
  userId: string,
  channelId: string,
  text: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo || convo.step !== "editing") return;

  // Parse duration from the message
  const durationMinutes = parseDurationMinutes(text);
  if (!durationMinutes || durationMinutes <= 0) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I couldn't find a duration in that message. Try something like:\n\u2022 _\"1 hour on Garnier deck\"_\n\u2022 _\"30 mins L'Or\u00e9al creative review\"_",
          },
        },
      ],
      "Couldn't parse duration"
    );
    return;
  }

  // Run the existing matcher with the user's text as a synthetic event
  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );

  const matches = await matchEvents(
    [{ id: "manual-1", title: text }],
    activeProjects
  );

  const match = matches[0];
  if (!match) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I couldn't match that to any project. Could you rephrase with a client or project name?",
          },
        },
      ],
      "No match found"
    );
    return;
  }

  // Store the pending entry
  convo.pendingEntry = {
    text,
    durationMinutes,
    projectId: match.project_id,
    projectName: match.project_name,
    clientName: match.client_name,
    taskId: match.task_id,
    taskTitle: match.task_title,
    confidence: match.confidence,
    description: match.description,
    isInternal: match.is_internal,
  };
  convo.step = "confirming";
  convo.slackChannelId = channelId;
  await saveConversation(convo);

  // Build confirmation message
  const dur = formatDuration(durationMinutes);
  const project = match.project_name || "unknown project";
  const client = match.client_name ? ` (${match.client_name})` : "";
  const billable = match.is_internal ? "non-billable" : "billable";

  let confirmText = `Logging *${dur}* against *${project}*${client}, ${billable}.`;
  if (match.task_title) {
    confirmText += `\nTask: ${match.task_title}`;
  }
  if (match.confidence === "low") {
    confirmText +=
      "\n\n\u26a0\ufe0f Low confidence match. Please check the project is correct.";
  }
  confirmText += "\n\nCorrect?";

  await postSlackReply(
    channelId,
    [
      {
        type: "section",
        text: { type: "mrkdwn", text: confirmText },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "\u2705 Yes", emoji: true },
            action_id: "confirm_entry",
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "\u274c No", emoji: true },
            action_id: "reject_entry",
            style: "danger",
          },
        ],
      },
    ],
    `Confirm: ${dur} on ${project}?`
  );
}

// ---------------------------------------------------------------------------
// POST handler — Slack Events API
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("SLACK_SIGNING_SECRET is not configured");
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  const rawBody = await request.text();

  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    console.warn("Slack events: signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  // Handle Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Only process message events
  if (body.type !== "event_callback") {
    return new NextResponse(null, { status: 200 });
  }

  const event = body.event;

  // Ignore bot messages, message edits, and non-message events
  if (
    !event ||
    event.type !== "message" ||
    event.subtype ||
    event.bot_id
  ) {
    return new NextResponse(null, { status: 200 });
  }

  const userId: string = event.user;
  const channelId: string = event.channel;
  const text: string = event.text || "";

  // Acknowledge immediately, process in background.
  // In Next.js edge/serverless we can't truly background work, but the
  // handler is fast enough (matcher call is the slowest part).
  // Slack retries if we don't respond within 3 seconds, so we respond
  // first and use waitUntil if available, otherwise just await.

  // Check if user has an active editing conversation
  const convo = await loadConversation(userId);
  if (convo && convo.step === "editing") {
    await handleFreeTextEntry(userId, channelId, text);
  }

  return new NextResponse(null, { status: 200 });
}
