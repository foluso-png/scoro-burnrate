// Required env vars:
//   SLACK_SIGNING_SECRET  - for request verification
//   SLACK_BOT_TOKEN       - for posting replies
//   ANTHROPIC_API_KEY     - for AI matching

import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import {
  loadConversation,
  saveConversation,
} from "@/lib/conversation";
import {
  matchEvents,
  getProjectLookup,
  splitActivities,
} from "@/lib/matcher";

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
  const normalized = text.toLowerCase();

  const hm = normalized.match(
    /(\d+(?:\.\d+)?)\s*h(?:ours?|rs?|r)?\s*(?:(\d+)\s*m(?:ins?|inutes?)?)?/
  );
  if (hm) {
    const hours = parseFloat(hm[1]);
    const mins = hm[2] ? parseInt(hm[2], 10) : 0;
    return Math.round(hours * 60) + mins;
  }

  const mOnly = normalized.match(/(\d+)\s*m(?:ins?|inutes?)?/);
  if (mOnly) {
    return parseInt(mOnly[1], 10);
  }

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

  // Use AI to split the message into individual activities with durations
  const activities = await splitActivities(text);
  const withDuration = activities.filter((a) => a.durationMinutes > 0);

  if (withDuration.length === 0) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I couldn't find a duration in that message. Try something like:\n\u2022 _\"1 hour on Garnier deck\"_\n\u2022 _\"30 mins L'Or\u00e9al creative review\"_\n\u2022 _\"30 mins admin and 1h on Wella deck\"_",
          },
        },
      ],
      "Couldn't parse duration"
    );
    return;
  }

  // Match each activity to a project
  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );
  const matches = await matchEvents(withDuration, activeProjects);

  // Build pending entries from matches
  const pendingEntries = withDuration.map((activity) => {
    const match = matches.find((m) => m.event_id === activity.id);
    return {
      text: activity.title,
      durationMinutes: activity.durationMinutes,
      projectId: match?.project_id ?? null,
      projectName: match?.project_name ?? null,
      clientName: match?.client_name ?? null,
      taskId: match?.task_id ?? null,
      taskTitle: match?.task_title ?? null,
      confidence: (match?.confidence ?? "low") as "high" | "medium" | "low",
      description: match?.description ?? activity.title,
      isInternal: match?.is_internal ?? false,
    };
  });

  const matched = pendingEntries.filter((e) => e.projectId !== null);
  if (matched.length === 0) {
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

  convo.pendingEntries = matched;
  convo.step = "confirming";
  convo.slackChannelId = channelId;
  await saveConversation(convo);

  // Build confirmation message
  let confirmText: string;

  if (matched.length === 1) {
    const pe = matched[0];
    const dur = formatDuration(pe.durationMinutes);
    const project = pe.projectName || "unknown project";
    const client = pe.clientName ? ` (${pe.clientName})` : "";
    const billable = pe.isInternal ? "non-billable" : "billable";
    confirmText = `Logging *${dur}* against *${project}*${client}, ${billable}.`;
    if (pe.taskTitle) confirmText += `\nTask: ${pe.taskTitle}`;
    if (pe.confidence === "low") {
      confirmText +=
        "\n\n\u26a0\ufe0f Low confidence match. Please check the project is correct.";
    }
    confirmText += "\n\nCorrect?";
  } else {
    confirmText = `Found *${matched.length} entries*:\n\n`;
    for (const pe of matched) {
      const dur = formatDuration(pe.durationMinutes);
      const project = pe.projectName || "unknown project";
      const billable = pe.isInternal ? "non-billable" : "billable";
      confirmText += `\u2022 *${dur}* \u2192 *${project}*, ${billable}`;
      if (pe.taskTitle) confirmText += ` (${pe.taskTitle})`;
      if (pe.confidence === "low") confirmText += " \u26a0\ufe0f";
      confirmText += "\n";
    }
    if (matched.some((pe) => pe.confidence === "low")) {
      confirmText +=
        "\n\u26a0\ufe0f Low confidence on some matches. Please check.";
    }
    confirmText += "\nConfirm all?";
  }

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
    matched.length === 1
      ? `Confirm: ${formatDuration(matched[0].durationMinutes)} on ${matched[0].projectName}?`
      : `Confirm ${matched.length} entries?`
  );
}

// ---------------------------------------------------------------------------
// Handle free-text message when user is in "fixing" step
// ---------------------------------------------------------------------------
async function handleFixText(
  userId: string,
  channelId: string,
  text: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo || convo.step !== "fixing") return;

  const approvedDrafts = convo.drafts.filter((d) => d.approved);

  // If we haven't identified which entry to fix yet, parse the user's reply
  if (convo.fixingDraftIndex === null) {
    // Try to match by number first
    const numMatch = text.match(/(\d+)/);
    let draftIdx: number | null = null;

    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num >= 1 && num <= approvedDrafts.length) {
        // Map from approved-list index to drafts[] index
        draftIdx = convo.drafts.indexOf(approvedDrafts[num - 1]);
      }
    }

    // If no number match, try to match by event title substring
    if (draftIdx === null) {
      const lower = text.toLowerCase();
      const matched = approvedDrafts.find((d) =>
        d.eventTitle.toLowerCase().includes(lower) ||
        lower.includes(d.eventTitle.toLowerCase().split(" ")[0])
      );
      if (matched) {
        draftIdx = convo.drafts.indexOf(matched);
      }
    }

    if (draftIdx === null) {
      await postSlackReply(
        channelId,
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "I couldn't work out which entry you mean. Reply with the number (e.g. _\"2\"_) or include part of the event name.",
            },
          },
        ],
        "Couldn't identify entry"
      );
      return;
    }

    convo.fixingDraftIndex = draftIdx;

    // Check if the message also contains a correction
    // Strip the number prefix if present to see if there's more context
    const correction = text.replace(/^\s*\d+\.?\s*/, "").trim();

    if (!correction) {
      await saveConversation(convo);
      const draft = convo.drafts[draftIdx];
      await postSlackReply(
        channelId,
        [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Fixing *${draft.eventTitle}* (currently \u2192 ${draft.projectName || "unmatched"}).\n\nWhat's wrong? For example:\n\u2022 _\"should be Garnier social\"_\n\u2022 _\"was actually 45 mins\"_\n\u2022 _\"internal time, not client work\"_`,
            },
          },
        ],
        `Fixing: ${draft.eventTitle}`
      );
      return;
    }

    // Fall through to process the correction text
    await saveConversation(convo);
    await processFixCorrection(convo, channelId, correction);
    return;
  }

  // We already know which entry — this message is the correction
  await processFixCorrection(convo, channelId, text);
}

async function processFixCorrection(
  convo: Awaited<ReturnType<typeof loadConversation>> & object,
  channelId: string,
  text: string
): Promise<void> {
  const idx = convo.fixingDraftIndex!;
  const draft = convo.drafts[idx];

  // Check for duration change
  const durationMinutes = parseDurationMinutes(text);

  // Re-match via AI to find the correct project
  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );

  const matches = await matchEvents(
    [{ id: "fix-1", title: text }],
    activeProjects
  );

  const match = matches[0];

  // If no match and no duration change, we can't do anything useful
  if (!match && !durationMinutes) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I couldn't match that to a project. Try being more specific with a client or project name.",
          },
        },
      ],
      "No match found"
    );
    return;
  }

  // Build the pending fix
  convo.pendingEntry = {
    text,
    durationMinutes: durationMinutes || draft.durationMinutes || 0,
    projectId: match?.project_id ?? draft.projectId,
    projectName: match?.project_name ?? draft.projectName,
    clientName: match?.client_name ?? null,
    taskId: match?.task_id ?? draft.taskId,
    taskTitle: match?.task_title ?? draft.taskTitle,
    confidence: match?.confidence ?? draft.confidence,
    description: match?.description ?? draft.description,
    isInternal: match?.is_internal ?? false,
  };
  convo.step = "fixing";
  convo.slackChannelId = channelId;
  await saveConversation(convo);

  // Build confirmation message
  const dur = formatDuration(convo.pendingEntry.durationMinutes);
  const project = convo.pendingEntry.projectName || "unknown project";
  const client = convo.pendingEntry.clientName
    ? ` (${convo.pendingEntry.clientName})`
    : "";
  const billable = convo.pendingEntry.isInternal
    ? "non-billable"
    : "billable";

  let confirmText = `Change *${draft.eventTitle}* to:\n\u2022 Project: *${project}*${client}, ${billable}`;
  if (convo.pendingEntry.taskTitle) {
    confirmText += `\n\u2022 Task: ${convo.pendingEntry.taskTitle}`;
  }
  if (durationMinutes) {
    confirmText += `\n\u2022 Duration: ${dur}`;
  }
  if (match?.confidence === "low") {
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
            action_id: "confirm_fix",
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "\u274c No", emoji: true },
            action_id: "reject_fix",
            style: "danger",
          },
        ],
      },
    ],
    `Fix: ${draft.eventTitle} \u2192 ${project}?`
  );
}

// ---------------------------------------------------------------------------
// POST handler — acknowledge immediately, defer work with after()
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

  // Handle Slack URL verification challenge (must respond synchronously)
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

  // Acknowledge immediately, process in background
  after(async () => {
    try {
      const convo = await loadConversation(userId);
      if (convo && convo.step === "editing") {
        await handleFreeTextEntry(userId, channelId, text);
      } else if (convo && convo.step === "fixing") {
        await handleFixText(userId, channelId, text);
      }
    } catch (err) {
      console.error(
        "Slack event handler error:",
        err instanceof Error ? err.message : err
      );
    }
  });

  return new NextResponse(null, { status: 200 });
}
