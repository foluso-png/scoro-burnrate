// Required env vars:
//   SLACK_SIGNING_SECRET - Slack app signing secret for request verification

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  loadConversation,
  saveConversation,
  clearConversation,
  DraftEntry,
} from "@/lib/conversation";

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return false;
  }

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
// Slack response helpers
// ---------------------------------------------------------------------------
function slackResponse(text: string): NextResponse {
  return NextResponse.json({
    response_type: "ephemeral",
    replace_original: false,
    text,
  });
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------
async function handleLooksRight(userId: string): Promise<NextResponse> {
  const convo = await loadConversation(userId);
  if (!convo) {
    return slackResponse("No active timesheet session found. Run the Co-pilot first.");
  }

  convo.step = "complete";
  await clearConversation(userId);

  const approvedCount = convo.drafts.filter((d) => d.approved).length;
  return slackResponse(
    `\u2705 All good. ${approvedCount} draft${approvedCount === 1 ? "" : "s"} confirmed in Scoro. Have a good evening.`
  );
}

async function handleAddTime(userId: string): Promise<NextResponse> {
  const convo = await loadConversation(userId);
  if (!convo) {
    return slackResponse("No active timesheet session found. Run the Co-pilot first.");
  }

  convo.step = "editing";
  await saveConversation(convo);

  return slackResponse(
    "What did you work on? Type something like:\n\u2022 _\"2 hours on the Garnier deck\"_\n\u2022 _\"30 mins L'Or\u00e9al creative review\"_\n\nI'll match it to a project and add the time entry."
  );
}

async function handleFixEntry(userId: string): Promise<NextResponse> {
  const convo = await loadConversation(userId);
  if (!convo) {
    return slackResponse("No active timesheet session found. Run the Co-pilot first.");
  }

  const draftList = convo.drafts
    .filter((d) => d.approved)
    .map((d, i) => `${i + 1}. ${d.eventTitle} \u2192 ${d.projectName || "unmatched"}`)
    .join("\n");

  if (!draftList) {
    return slackResponse("No entries to fix. Try *Add time* instead.");
  }

  // Keep step as review_matches for now; the fix flow will be built next
  await saveConversation(convo);

  return slackResponse(
    `Which entry needs fixing?\n\n${draftList}\n\nReply with the number or describe what's wrong. (Fix flow coming soon.)`
  );
}

// ---------------------------------------------------------------------------
// Confirm / reject pending entry
// ---------------------------------------------------------------------------
function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function handleConfirmEntry(userId: string): Promise<NextResponse> {
  const convo = await loadConversation(userId);
  if (!convo || !convo.pendingEntry) {
    return slackResponse("Nothing to confirm. Try *Add time* first.");
  }

  const pe = convo.pendingEntry;

  const draft: DraftEntry = {
    eventId: `manual-${Date.now()}`,
    eventTitle: pe.text,
    projectId: pe.projectId,
    projectName: pe.projectName,
    taskId: pe.taskId,
    taskTitle: pe.taskTitle,
    confidence: pe.confidence,
    description: pe.description,
    approved: true,
    scoroEntryId: null,
  };

  convo.drafts.push(draft);
  convo.pendingEntry = null;
  convo.step = "review_matches";
  await saveConversation(convo);

  const dur = formatDuration(pe.durationMinutes);
  const project = pe.projectName || "unknown project";

  return slackResponse(
    `\u2705 Added: ${dur} on ${project}.\n\nAnything else? Type another entry, or tap *Looks right* on the original message when you're done.`
  );
}

async function handleRejectEntry(userId: string): Promise<NextResponse> {
  const convo = await loadConversation(userId);
  if (!convo || !convo.pendingEntry) {
    return slackResponse("Nothing to reject.");
  }

  convo.pendingEntry = null;
  convo.step = "editing";
  await saveConversation(convo);

  return slackResponse(
    "No worries. Try rephrasing with a clearer project or client name, like:\n\u2022 _\"1h Wella TikTok edits\"_\n\u2022 _\"45 mins Garnier shoot brief\"_"
  );
}

// ---------------------------------------------------------------------------
// POST handler — Slack interactivity callback
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

  // Slack sends the body as application/x-www-form-urlencoded
  const rawBody = await request.text();

  // Verify request signature
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    console.warn("Slack signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse the form-encoded payload field
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  const payload = JSON.parse(payloadStr);
  const userId: string = payload.user?.id || "";
  const actions: Array<{ action_id: string; value?: string }> =
    payload.actions || [];

  if (!userId || actions.length === 0) {
    return NextResponse.json({ text: "Nothing to do." });
  }

  const actionId = actions[0].action_id;

  console.log(
    `Slack interaction: user=${payload.user?.username || userId} action_id=${actionId}`
  );

  switch (actionId) {
    case "looks_right":
      return handleLooksRight(userId);
    case "add_time":
      return handleAddTime(userId);
    case "fix_entry":
      return handleFixEntry(userId);
    case "confirm_entry":
      return handleConfirmEntry(userId);
    case "reject_entry":
      return handleRejectEntry(userId);
    default:
      console.warn(`Unknown action_id: ${actionId}`);
      return slackResponse(`Unknown action: ${actionId}`);
  }
}
