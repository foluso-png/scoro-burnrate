// Required env vars:
//   SLACK_SIGNING_SECRET - Slack app signing secret for request verification
//   SLACK_BOT_TOKEN      - for posting follow-up messages

import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import {
  loadConversation,
  saveConversation,
  clearConversation,
  DraftEntry,
} from "@/lib/conversation";
import { finaliseAndWrite, updateExistingEntry } from "@/lib/scoro-writer";
import { runCopilotSummary } from "@/lib/copilot-summary";

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
// Post results back to Slack after acknowledgement
// ---------------------------------------------------------------------------
async function postToResponseUrl(
  responseUrl: string,
  text: string
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text,
    }),
  });
}

async function postSlackDm(channel: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
}

// ---------------------------------------------------------------------------
// Action buttons block (reusable across handlers)
// ---------------------------------------------------------------------------
function buildActionButtons(): Record<string, unknown> {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "\u2705 Looks right", emoji: true },
        action_id: "looks_right",
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "\u2795 Add time", emoji: true },
        action_id: "add_time",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "\u270f\ufe0f Fix an entry",
          emoji: true,
        },
        action_id: "fix_entry",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "\ud83d\udd04 Wrap up my day",
          emoji: true,
        },
        action_id: "wrap_up",
      },
    ],
  };
}

async function postResponseWithButtons(
  responseUrl: string,
  text: string
): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        buildActionButtons(),
      ],
    }),
  });
}

// ---------------------------------------------------------------------------
// Button handlers — post results via response_url or chat.postMessage
// ---------------------------------------------------------------------------
function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function handleLooksRight(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(
      responseUrl,
      "No active timesheet session found. Run the Co-pilot first."
    );
    return;
  }

  const approvedDrafts = convo.drafts.filter((d) => d.approved);
  if (approvedDrafts.length === 0) {
    await clearConversation(userId);
    await postToResponseUrl(
      responseUrl,
      "\u2705 No entries to write. Session closed."
    );
    return;
  }

  // Write all approved drafts to Scoro (the slow part)
  const results = await finaliseAndWrite(convo);
  await clearConversation(userId);

  const written = results.filter((r) => !r.error && r.action !== "skipped");
  const failed = results.filter((r) => r.error);

  let summary = `\u2705 Done. ${written.length} entry${written.length === 1 ? "" : "s"} written to Scoro:\n`;
  summary += written
    .map(
      (r) =>
        `\u2022 ${formatDuration(r.durationMinutes)} ${r.projectName || "unknown"} (${r.action})`
    )
    .join("\n");

  if (failed.length > 0) {
    summary += `\n\n\u26a0\ufe0f ${failed.length} failed:\n`;
    summary += failed
      .map((r) => `\u2022 ${r.eventTitle}: ${r.error}`)
      .join("\n");
  }

  summary += "\n\nAll done. Have a good evening!";

  await postToResponseUrl(responseUrl, summary);
}

async function handleAddTime(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(
      responseUrl,
      "No active timesheet session found. Run the Co-pilot first."
    );
    return;
  }

  convo.step = "editing";
  await saveConversation(convo);

  await postToResponseUrl(
    responseUrl,
    "What did you work on? Type something like:\n\u2022 _\"2 hours on the Garnier deck\"_\n\u2022 _\"30 mins L'Or\u00e9al creative review\"_\n\nI'll match it to a project and add the time entry."
  );
}

async function handleFixEntry(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(
      responseUrl,
      "No active timesheet session found. Run the Co-pilot first."
    );
    return;
  }

  const approvedDrafts = convo.drafts.filter((d) => d.approved);
  if (approvedDrafts.length === 0) {
    await postToResponseUrl(
      responseUrl,
      "No entries to fix. Try *Add time* instead."
    );
    return;
  }

  const draftList = approvedDrafts
    .map(
      (d, i) =>
        `${i + 1}. ${d.eventTitle} \u2192 ${d.projectName || "unmatched"} (${formatDuration(d.durationMinutes || 0)})`
    )
    .join("\n");

  convo.step = "fixing";
  convo.fixingDraftIndex = null;
  await saveConversation(convo);

  await postToResponseUrl(
    responseUrl,
    `Which entry needs fixing?\n\n${draftList}\n\nReply with the number or describe what's wrong.`
  );
}

async function handleConfirmEntry(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(
      responseUrl,
      "Nothing to confirm. Try *Add time* first."
    );
    return;
  }

  const entries = convo.pendingEntries || [];
  if (entries.length === 0) {
    await postToResponseUrl(
      responseUrl,
      "Nothing to confirm. Try *Add time* first."
    );
    return;
  }

  for (const pe of entries) {
    const draft: DraftEntry = {
      eventId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      eventTitle: pe.text,
      projectId: pe.projectId,
      projectName: pe.projectName,
      taskId: pe.taskId,
      taskTitle: pe.taskTitle,
      confidence: pe.confidence,
      description: pe.description,
      approved: true,
      scoroEntryId: null,
      durationMinutes: pe.durationMinutes,
      startDatetime: null,
      endDatetime: null,
    };
    convo.drafts.push(draft);
  }

  const count = entries.length;
  const summary = entries
    .map((pe) => {
      const dur = formatDuration(pe.durationMinutes);
      const project = pe.projectName || "unknown project";
      return `\u2022 ${dur} on ${project}`;
    })
    .join("\n");

  convo.pendingEntries = [];
  convo.pendingEntry = null;
  convo.step = "review_matches";
  await saveConversation(convo);

  const label = count === 1 ? "entry" : "entries";
  await postResponseWithButtons(
    responseUrl,
    `\u2705 Added ${count} ${label}:\n${summary}`
  );
}

async function handleRejectEntry(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(responseUrl, "Nothing to reject.");
    return;
  }

  convo.pendingEntry = null;
  convo.pendingEntries = [];
  convo.step = "editing";
  await saveConversation(convo);

  await postToResponseUrl(
    responseUrl,
    "No worries. Try rephrasing with a clearer project or client name, like:\n\u2022 _\"1h Wella TikTok edits\"_\n\u2022 _\"45 mins Garnier shoot brief\"_"
  );
}

async function handleConfirmFix(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo || !convo.pendingEntry || convo.fixingDraftIndex === null) {
    await postToResponseUrl(responseUrl, "Nothing to confirm.");
    return;
  }

  const idx = convo.fixingDraftIndex;
  const draft = convo.drafts[idx];
  const pe = convo.pendingEntry;

  // Update the draft in conversation state
  draft.projectId = pe.projectId;
  draft.projectName = pe.projectName;
  draft.taskId = pe.taskId;
  draft.taskTitle = pe.taskTitle;
  draft.confidence = pe.confidence;
  draft.description = pe.description;
  if (pe.durationMinutes) {
    draft.durationMinutes = pe.durationMinutes;
  }

  // If there's an existing Scoro entry, update it in place
  if (draft.scoroEntryId && draft.taskId !== null) {
    try {
      await updateExistingEntry(draft.scoroEntryId, {
        taskId: draft.taskId,
        durationMinutes: draft.durationMinutes || undefined,
        description: draft.description,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await postToResponseUrl(
        responseUrl,
        `Failed to update Scoro entry: ${msg}`
      );
      return;
    }
  }

  convo.pendingEntry = null;
  convo.fixingDraftIndex = null;
  convo.step = "review_matches";
  await saveConversation(convo);

  const dur = formatDuration(draft.durationMinutes || 0);
  const project = draft.projectName || "unknown project";
  const updated = draft.scoroEntryId ? " Scoro entry updated." : "";

  await postResponseWithButtons(
    responseUrl,
    `\u2705 Fixed: ${draft.eventTitle} \u2192 ${project} (${dur}).${updated}`
  );
}

async function handleRejectFix(
  userId: string,
  responseUrl: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(responseUrl, "Nothing to reject.");
    return;
  }

  convo.pendingEntry = null;
  convo.step = "fixing";
  await saveConversation(convo);

  await postToResponseUrl(
    responseUrl,
    "No worries. Describe the correct project or client more specifically, like:\n\u2022 _\"it was Wella TikTok\"_\n\u2022 _\"should be internal time\"_"
  );
}

async function handleWrapUp(
  userId: string,
  responseUrl: string,
  channelId: string
): Promise<void> {
  await postToResponseUrl(responseUrl, "Running your summary\u2026");

  try {
    await runCopilotSummary(userId, {
      channelId,
      writeToScoro: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postToResponseUrl(
      responseUrl,
      `Something went wrong running your summary: ${msg}`
    );
  }
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
    console.warn("Slack signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  const payload = JSON.parse(payloadStr);
  const userId: string = payload.user?.id || "";
  const responseUrl: string = payload.response_url || "";
  const channelId: string = payload.channel?.id || userId;
  const actions: Array<{ action_id: string; value?: string }> =
    payload.actions || [];

  if (!userId || actions.length === 0) {
    return new NextResponse(null, { status: 200 });
  }

  const actionId = actions[0].action_id;

  console.log(
    `Slack interaction: user=${payload.user?.username || userId} action_id=${actionId}`
  );

  // Acknowledge immediately, run handler in background
  after(async () => {
    try {
      switch (actionId) {
        case "looks_right":
          await handleLooksRight(userId, responseUrl);
          break;
        case "add_time":
          await handleAddTime(userId, responseUrl);
          break;
        case "fix_entry":
          await handleFixEntry(userId, responseUrl);
          break;
        case "confirm_entry":
          await handleConfirmEntry(userId, responseUrl);
          break;
        case "reject_entry":
          await handleRejectEntry(userId, responseUrl);
          break;
        case "confirm_fix":
          await handleConfirmFix(userId, responseUrl);
          break;
        case "reject_fix":
          await handleRejectFix(userId, responseUrl);
          break;
        case "wrap_up":
          await handleWrapUp(userId, responseUrl, channelId);
          break;
        default:
          console.warn(`Unknown action_id: ${actionId}`);
          if (responseUrl) {
            await postToResponseUrl(
              responseUrl,
              `Unknown action: ${actionId}`
            );
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Interaction handler error (${actionId}):`, msg);
      if (responseUrl) {
        await postToResponseUrl(
          responseUrl,
          `Something went wrong: ${msg}`
        ).catch(() => {});
      }
    }
  });

  return new NextResponse(null, { status: 200 });
}
