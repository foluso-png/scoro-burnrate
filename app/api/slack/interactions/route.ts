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
import { saveEventMapping } from "@/lib/event-memory";
import { getProjectLookup } from "@/lib/matcher";
import { loadUserPrefs } from "@/lib/user-prefs";
import {
  loadProjectTaskMemory,
  saveProjectTaskMapping,
} from "@/lib/project-task-memory";
import {
  loadPendingLeave,
  clearPendingLeave,
} from "@/lib/pending-leave";
import { scoroPost } from "@/lib/matcher";
import { assertCanWrite, DemoModeBlockedError } from "@/lib/demo-gate";
import { isDemoMode, DEMO_BANNER } from "@/lib/user-prefs";

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
          text: "\ud83d\udcdd Log my day",
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

  // Validate Scoro user ID before writing
  const prefs = await loadUserPrefs(userId);
  if (!prefs.scoroUserId) {
    await postToResponseUrl(
      responseUrl,
      "Your Scoro user ID hasn't been set up yet. Please reconnect at /connect or ask Foluso to set it manually."
    );
    return;
  }

  // Write all approved drafts to Scoro (the slow part)
  let results: Awaited<ReturnType<typeof finaliseAndWrite>>;
  try {
    results = await finaliseAndWrite(convo, prefs.scoroUserId);
  } catch (err) {
    if (err instanceof DemoModeBlockedError) {
      await saveMemoryForDrafts(userId, approvedDrafts);
      await clearConversation(userId);
      const count = approvedDrafts.length;
      await postToResponseUrl(
        responseUrl,
        DEMO_BANNER + `${count} entry${count === 1 ? "" : "s"} matched but nothing was saved to Scoro.`
      );
      return;
    }
    throw err;
  }

  // Save confirmed event→project mappings for future memory
  await saveMemoryForDrafts(userId, approvedDrafts);

  await clearConversation(userId);

  const written = results.filter((r) => !r.error && r.action !== "skipped" && r.action !== "skipped_demo" && r.action !== "failed");
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
      await updateExistingEntry(userId, draft.scoroEntryId, {
        taskId: draft.taskId,
        durationMinutes: draft.durationMinutes || undefined,
        description: draft.description,
      });
    } catch (err) {
      if (err instanceof DemoModeBlockedError) {
        await postToResponseUrl(
          responseUrl,
          DEMO_BANNER + "Fix noted but nothing was saved to Scoro."
        );
        // Still update conversation state so the demo flow continues
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        await postToResponseUrl(
          responseUrl,
          `Failed to update Scoro entry: ${msg}`
        );
        return;
      }
    }
  }

  convo.pendingEntry = null;
  convo.fixingDraftIndex = null;
  convo.step = "review_matches";
  await saveConversation(convo);

  // Save corrected mapping to memory (calendar events only)
  if (draft.startDatetime && draft.projectId) {
    await saveEventMapping(userId, draft.eventTitle, {
      project_id: draft.projectId,
      project_name: draft.projectName || "",
      task_id: draft.taskId,
      task_title: draft.taskTitle,
    });
  }

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

// ---------------------------------------------------------------------------
// Save event→project memory for calendar-based drafts
// ---------------------------------------------------------------------------
async function saveMemoryForDrafts(
  userId: string,
  drafts: DraftEntry[]
): Promise<void> {
  for (const d of drafts) {
    // Only save calendar events (have start/end times) with a valid project
    if (!d.startDatetime || !d.projectId) continue;
    await saveEventMapping(userId, d.eventTitle, {
      project_id: d.projectId,
      project_name: d.projectName || "",
      task_id: d.taskId,
      task_title: d.taskTitle,
    });
  }
}

// ---------------------------------------------------------------------------
// Dropdown selection for low-confidence matches
// ---------------------------------------------------------------------------
async function handleSelectProject(
  userId: string,
  responseUrl: string,
  blockId: string,
  selectedValue: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(responseUrl, "No active session found.");
    return;
  }

  // blockId is "low_conf_0", "low_conf_1", etc.
  const lowConfIdx = parseInt(blockId.replace("low_conf_", ""), 10);
  const unapprovedDrafts = convo.drafts.filter((d) => !d.approved);

  if (isNaN(lowConfIdx) || lowConfIdx >= unapprovedDrafts.length) {
    await postToResponseUrl(responseUrl, "Could not identify the entry.");
    return;
  }

  const draft = unapprovedDrafts[lowConfIdx];
  const draftIdx = convo.drafts.indexOf(draft);

  if (selectedValue === "skip") {
    convo.drafts.splice(draftIdx, 1);
    await saveConversation(convo);
    await postResponseWithButtons(
      responseUrl,
      `Skipped *${draft.eventTitle}*.`
    );
    return;
  }

  // Value is now just the project ID (no task baked in)
  const projectId = parseInt(selectedValue, 10);
  if (isNaN(projectId)) {
    // Backwards compat: handle old "pid:tid" format if cached messages exist
    const parts = selectedValue.split(":");
    const pid = parseInt(parts[0], 10);
    if (!isNaN(pid)) {
      return handleSelectProject(userId, responseUrl, blockId, parts[0]);
    }
    await postToResponseUrl(responseUrl, "Invalid selection.");
    return;
  }

  const lookup = await getProjectLookup();
  const project = lookup.projects.find((p) => p.project_id === projectId);

  if (!project) {
    await postToResponseUrl(responseUrl, "Could not find that project.");
    return;
  }

  // Task resolution: memory > defaultRole > single task > ask
  let resolvedTask = project.tasks[0] || null;
  let taskConfident = project.tasks.length <= 1;

  // 1. Check project-task memory
  const projectTaskMem = await loadProjectTaskMemory(userId);
  const remembered = projectTaskMem[String(projectId)];
  if (remembered) {
    const memTask = project.tasks.find(
      (t) => t.task_id === remembered.task_id
    );
    if (memTask) {
      resolvedTask = memTask;
      taskConfident = true;
    }
  }

  // 2. Check defaultRole
  if (!taskConfident && project.tasks.length > 1) {
    const prefs = await loadUserPrefs(userId);
    if (prefs.defaultRole) {
      const roleLower = prefs.defaultRole.toLowerCase();
      const roleMatch = project.tasks.find(
        (t) => t.title.toLowerCase().includes(roleLower)
      );
      if (roleMatch) {
        resolvedTask = roleMatch;
        taskConfident = true;
      }
    }
  }

  // 3. If still uncertain and multiple tasks, show task dropdown
  if (!taskConfident && project.tasks.length > 1) {
    // Set draft to this project but mark task as uncertain
    convo.drafts[draftIdx] = {
      ...draft,
      projectId: project.project_id,
      projectName: project.name,
      taskId: resolvedTask?.task_id ?? null,
      taskTitle: resolvedTask?.title ?? null,
      confidence: "high",
      description: draft.description,
      approved: true,
      taskUncertain: true,
    };
    await saveConversation(convo);

    // Save event memory (project known, task will be refined)
    await saveEventMapping(userId, draft.eventTitle, {
      project_id: project.project_id,
      project_name: project.name,
      task_id: resolvedTask?.task_id ?? null,
      task_title: resolvedTask?.title ?? null,
    });

    // Count task-uncertain drafts to get the right block_id index
    const taskUncertainDrafts = convo.drafts.filter(
      (d) => d.approved && d.taskUncertain
    );
    const taskIdx = taskUncertainDrafts.indexOf(convo.drafts[draftIdx]);
    const taskBlockId = `task_conf_${taskIdx >= 0 ? taskIdx : 0}`;

    const taskOptions = project.tasks.map((t) => ({
      text: { type: "plain_text" as const, text: t.title.slice(0, 75) },
      value: String(t.task_id),
    }));

    const channelId = convo.slackChannelId || userId;
    const token = process.env.SLACK_BOT_TOKEN;
    if (token) {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: channelId,
          text: `Matched *${draft.eventTitle}* to *${project.name}*. Which task/role?`,
          blocks: [
            {
              type: "section",
              block_id: taskBlockId,
              text: {
                type: "mrkdwn",
                text: `Matched *${draft.eventTitle}* to *${project.name}*. Which task/role?`,
              },
              accessory: {
                type: "static_select",
                action_id: "select_task",
                placeholder: {
                  type: "plain_text",
                  text: "Pick your role/task...",
                },
                options: taskOptions,
              },
            },
          ],
        }),
      });
    }
    return;
  }

  // Confident in both project and task — approve and save
  convo.drafts[draftIdx] = {
    ...draft,
    projectId: project.project_id,
    projectName: project.name,
    taskId: resolvedTask?.task_id ?? null,
    taskTitle: resolvedTask?.title ?? null,
    confidence: "high",
    description: draft.description,
    approved: true,
  };
  await saveConversation(convo);

  await saveEventMapping(userId, draft.eventTitle, {
    project_id: project.project_id,
    project_name: project.name,
    task_id: resolvedTask?.task_id ?? null,
    task_title: resolvedTask?.title ?? null,
  });

  const dur = draft.durationMinutes
    ? formatDuration(draft.durationMinutes)
    : "";
  await postResponseWithButtons(
    responseUrl,
    `Matched *${draft.eventTitle}* ${dur ? `(${dur}) ` : ""}\u2192 *${project.name}* (${resolvedTask?.title || "default task"}). Saved for next time.`
  );
}

// ---------------------------------------------------------------------------
// Task dropdown selection for uncertain task matches
// ---------------------------------------------------------------------------
async function handleSelectTask(
  userId: string,
  responseUrl: string,
  blockId: string,
  selectedValue: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    await postToResponseUrl(responseUrl, "No active session found.");
    return;
  }

  // blockId is "task_conf_0", "task_conf_1", etc.
  const taskConfIdx = parseInt(blockId.replace("task_conf_", ""), 10);
  const taskUncertainDrafts = convo.drafts.filter(
    (d) => d.approved && d.taskUncertain
  );

  if (isNaN(taskConfIdx) || taskConfIdx >= taskUncertainDrafts.length) {
    await postToResponseUrl(responseUrl, "Could not identify the entry.");
    return;
  }

  const draft = taskUncertainDrafts[taskConfIdx];
  const draftIdx = convo.drafts.indexOf(draft);
  const taskId = parseInt(selectedValue, 10);
  if (isNaN(taskId)) {
    await postToResponseUrl(responseUrl, "Invalid task selection.");
    return;
  }

  // Look up task name from project data
  const lookup = await getProjectLookup();
  const project = draft.projectId
    ? lookup.projects.find((p) => p.project_id === draft.projectId)
    : null;
  const task = project?.tasks.find((t) => t.task_id === taskId) || null;

  convo.drafts[draftIdx] = {
    ...draft,
    taskId,
    taskTitle: task?.title || draft.taskTitle,
    taskUncertain: false,
  };
  await saveConversation(convo);

  // Update event memory with the confirmed task
  if (draft.startDatetime && draft.projectId) {
    await saveEventMapping(userId, draft.eventTitle, {
      project_id: draft.projectId,
      project_name: draft.projectName || "",
      task_id: taskId,
      task_title: task?.title || null,
    });
  }

  // Remember this task choice for all future entries on this project
  if (draft.projectId && task) {
    await saveProjectTaskMapping(userId, draft.projectId, taskId, task.title);
  }

  await postResponseWithButtons(
    responseUrl,
    `Updated *${draft.eventTitle}* task to *${task?.title || "unknown"}*. Saved for next time.`
  );
}

async function handleWrapUp(
  userId: string,
  responseUrl: string,
  channelId: string
): Promise<void> {
  await postToResponseUrl(responseUrl, "Running your summary\u2026");

  try {
    const result = await runCopilotSummary(userId, {
      channelId,
      writeToScoro: false,
    });
    if (result.slackStatus === "skipped: already sent today") {
      await postToResponseUrl(
        responseUrl,
        "You've already had today's summary. Check your messages above."
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Wrap-up summary error:", msg);
    const userFacing = msg.startsWith("Could not match")
      || msg.startsWith("Your calendar matching was cut short")
      ? msg
      : "Something went wrong running your summary. Try again in a minute, or message Foluso if it keeps happening.";
    await postToResponseUrl(responseUrl, userFacing);
  }
}

// ---------------------------------------------------------------------------
// Annual leave confirmation
// ---------------------------------------------------------------------------
async function handleConfirmLeave(
  userId: string,
  responseUrl: string
): Promise<void> {
  const leave = await loadPendingLeave(userId);
  if (!leave) {
    await postToResponseUrl(responseUrl, "No pending leave request found. Try again.");
    return;
  }

  try {
    await assertCanWrite(userId);

    const res = await scoroPost<{ id: number }>("/timeOffs/modify", {
      request: {
        type: "vacation",
        reason: "Annual leave",
        start_date: leave.dates[0],
        end_date: leave.dates[leave.dates.length - 1],
        usersDates: [
          {
            user_id: leave.scoroUserId,
            dates: leave.dates.map((d) => ({ date: d, value: -1 })),
          },
        ],
      },
    });

    const entryId = res.data?.id;
    if (!entryId) {
      const errMsg =
        (res as { messages?: { error?: string[] } }).messages?.error?.[0] ||
        "Unknown error";
      await postToResponseUrl(
        responseUrl,
        `Failed to write leave to Scoro: ${errMsg}`
      );
      await clearPendingLeave(userId);
      return;
    }

    await clearPendingLeave(userId);
    await postToResponseUrl(
      responseUrl,
      `\u2705 Annual leave logged for *${leave.startLabel}* (${leave.dates.length} day${leave.dates.length === 1 ? "" : "s"}). Scoro entry ID: ${entryId}.`
    );
  } catch (err) {
    await clearPendingLeave(userId);
    if (err instanceof DemoModeBlockedError) {
      await postToResponseUrl(
        responseUrl,
        DEMO_BANNER + `Annual leave for *${leave.startLabel}* noted but nothing was saved to Scoro.`
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await postToResponseUrl(
      responseUrl,
      `Something went wrong writing leave to Scoro: ${msg}`
    );
  }
}

async function handleRejectLeave(
  userId: string,
  responseUrl: string
): Promise<void> {
  await clearPendingLeave(userId);
  await postToResponseUrl(responseUrl, "No worries, leave not logged.");
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
  const actions: Array<{
    action_id: string;
    value?: string;
    block_id?: string;
    selected_option?: { value: string };
  }> = payload.actions || [];

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
        case "select_project": {
          const blockId = actions[0].block_id || "";
          const selectedValue =
            actions[0].selected_option?.value || "";
          await handleSelectProject(
            userId,
            responseUrl,
            blockId,
            selectedValue
          );
          break;
        }
        case "select_task": {
          const taskBlockId = actions[0].block_id || "";
          const taskValue =
            actions[0].selected_option?.value || "";
          await handleSelectTask(
            userId,
            responseUrl,
            taskBlockId,
            taskValue
          );
          break;
        }
        case "wrap_up":
          await handleWrapUp(userId, responseUrl, channelId);
          break;
        case "confirm_leave":
          await handleConfirmLeave(userId, responseUrl);
          break;
        case "reject_leave":
          await handleRejectLeave(userId, responseUrl);
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
