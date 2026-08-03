// Required env vars:
//   SLACK_SIGNING_SECRET  - for request verification
//   SLACK_BOT_TOKEN       - for posting replies
//   ANTHROPIC_API_KEY     - for AI matching

import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import {
  loadConversation,
  saveConversation,
  clearConversation,
} from "@/lib/conversation";
import {
  matchEvents,
  getProjectLookup,
  splitAndMatchFreeText,
  classifyEndOfDayIntent,
} from "@/lib/matcher";
import {
  runCopilotSummary,
  checkScoroEntriesForDate,
  checkWeekSubmitted,
} from "@/lib/copilot-summary";
import { finaliseAndWrite } from "@/lib/scoro-writer";
import { saveEventMapping } from "@/lib/event-memory";
import { loadUserPrefs, saveUserPrefs } from "@/lib/user-prefs";
import { CAMPFIRE_ROLES } from "@/lib/roles";

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

  // Single AI call: split into activities, extract durations, match to projects
  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );
  const entries = await splitAndMatchFreeText(text, activeProjects);
  const withDuration = entries.filter((a) => a.durationMinutes > 0);

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

  // Build pending entries from combined results
  const pendingEntries = withDuration.map((entry) => ({
    text: entry.title,
    durationMinutes: entry.durationMinutes,
    projectId: entry.project_id,
    projectName: entry.project_name,
    clientName: entry.client_name,
    taskId: entry.task_id,
    taskTitle: entry.task_title,
    confidence: entry.confidence,
    description: entry.description,
    isInternal: entry.is_internal,
  }));

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

    // If no number match, try to match by distinctive words in the title
    if (draftIdx === null) {
      const noise = new Set([
        "a", "an", "the", "my", "with", "on", "in", "for", "and", "or",
        "to", "of", "is", "was", "not", "no", "it", "-", "/", "&", "—",
        "meeting", "catch", "up", "call", "chat", "sync", "discussion",
        "actually", "should", "be", "time", "hour", "hours", "mins",
        "minutes", "min", "internal", "entry",
      ]);
      const tokenise = (s: string): string[] =>
        s.toLowerCase()
          .split(/[\s\/\-&,]+/)
          .filter((w) => w.length > 1 && !noise.has(w));

      const userWords = new Set(tokenise(text));

      // Score each draft by how many of its title words appear in the user's message
      const scored = approvedDrafts.map((d, i) => {
        const titleWords = tokenise(d.eventTitle);
        const hits = titleWords.filter((w) => userWords.has(w)).length;
        return { draft: d, approvedIdx: i, hits };
      });

      // Only consider entries with at least one matching word
      const withHits = scored.filter((s) => s.hits > 0);

      if (withHits.length === 1) {
        draftIdx = convo.drafts.indexOf(withHits[0].draft);
      } else if (withHits.length > 1) {
        // Pick the best match, but only if it's unambiguous (strictly more hits than runner-up)
        withHits.sort((a, b) => b.hits - a.hits);
        if (withHits[0].hits > withHits[1].hits) {
          draftIdx = convo.drafts.indexOf(withHits[0].draft);
        }
        // Otherwise ambiguous — fall through to "couldn't identify" prompt
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

/**
 * Detect if the user is trying to split an entry across multiple projects.
 * Patterns: "split X to A and Y to B", "15 min on A and 45 min on B",
 * multiple duration mentions, or the word "split".
 */
function looksLikeMultiProjectSplit(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\bsplit\b/.test(lower)) return true;
  // Count distinct duration mentions
  const durations = lower.match(
    /\d+\s*(h(ours?|rs?|r)?|m(ins?|inutes?)?)\b/gi
  );
  if (durations && durations.length >= 2) {
    // Check for "and" or "," between them, suggesting different destinations
    if (/\d+\s*(h|m|hours?|mins?|minutes?)\b.*\b(and|,)\b.*\d+\s*(h|m|hours?|mins?|minutes?)\b/i.test(lower)) {
      return true;
    }
  }
  return false;
}

async function processFixCorrection(
  convo: Awaited<ReturnType<typeof loadConversation>> & object,
  channelId: string,
  text: string
): Promise<void> {
  // Detect multi-project split attempts and warn
  if (looksLikeMultiProjectSplit(text)) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "I can't split an entry across multiple projects via *Fix an entry*. To log time against different projects, use *Add time* instead and add each piece separately.",
          },
        },
      ],
      "Can't split across projects"
    );
    return;
  }

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
// Pause / resume notifications
// ---------------------------------------------------------------------------
const PAUSE_PATTERN =
  /\b(stop|pause|disable|turn off|mute)\b.*\b(notification|summary|summaries|copilot|co-pilot|bot|messages?)\b/i;
const RESUME_PATTERN =
  /\b(start|resume|enable|turn on|unmute)\b.*\b(notification|summary|summaries|copilot|co-pilot|bot|messages?)\b/i;

async function handlePauseResume(
  userId: string,
  channelId: string,
  text: string
): Promise<boolean> {
  if (PAUSE_PATTERN.test(text)) {
    const prefs = await loadUserPrefs(userId);
    prefs.paused = true;
    await saveUserPrefs(userId, prefs);
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: "Notifications paused. Message me \"start notifications\" whenever you want them back." } }],
      "Notifications paused"
    );
    return true;
  }
  if (RESUME_PATTERN.test(text)) {
    const prefs = await loadUserPrefs(userId);
    prefs.paused = false;
    await saveUserPrefs(userId, prefs);
    const hour = prefs.deliveryHour;
    const timeStr = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: `Notifications resumed. You'll get your summary at ${timeStr} each weekday.` } }],
      "Notifications resumed"
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Delivery time configuration
// ---------------------------------------------------------------------------
const TIME_PATTERN =
  /\b(?:send|deliver|schedule|set)\b.*\b(?:summary|timesheet|notification)\b.*?\b(\d{1,2})\s*([ap]m)\b/i;
const TIME_PATTERN_ALT =
  /\b(?:send|deliver|schedule|set)\b.*\bat\s+(\d{1,2})\s*([ap]m)\b/i;

function parseDeliveryHour(text: string): number | null {
  const match = TIME_PATTERN.exec(text) || TIME_PATTERN_ALT.exec(text);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const ampm = match[2].toLowerCase();
  if (hour < 1 || hour > 12) return null;
  if (ampm === "am" && hour === 12) hour = 0;
  else if (ampm === "pm" && hour !== 12) hour += 12;
  return hour;
}

async function handleDeliveryTime(
  userId: string,
  channelId: string,
  text: string
): Promise<boolean> {
  const hour = parseDeliveryHour(text);
  if (hour === null) return false;

  const prefs = await loadUserPrefs(userId);
  prefs.deliveryHour = hour;
  await saveUserPrefs(userId, prefs);

  const timeStr = `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
  await postSlackReply(
    channelId,
    [{ type: "section", text: { type: "mrkdwn", text: `Got it. Your daily summary will arrive at *${timeStr}* (UK time) each weekday.` } }],
    `Delivery time set to ${timeStr}`
  );
  return true;
}

// ---------------------------------------------------------------------------
// Role change — "set my role to Senior Account Manager", etc.
// ---------------------------------------------------------------------------
const ROLE_PATTERN =
  /\b(?:set|change|update)\s+(?:my\s+)?role\s+to\s+(.+)/i;

function matchRole(input: string): string | null {
  const inputLower = input.trim().toLowerCase();
  // Exact match first
  const exact = CAMPFIRE_ROLES.find(
    (r) => r.toLowerCase() === inputLower
  );
  if (exact) return exact;
  // Substring match (input contained within a role name, or vice versa)
  const partial = CAMPFIRE_ROLES.find(
    (r) => r.toLowerCase().includes(inputLower) || inputLower.includes(r.toLowerCase())
  );
  return partial || null;
}

async function handleRoleChange(
  userId: string,
  channelId: string,
  text: string
): Promise<boolean> {
  const match = ROLE_PATTERN.exec(text);
  if (!match) return false;

  const rawRole = match[1].trim().replace(/[."']+$/, ""); // strip trailing punctuation
  const role = matchRole(rawRole);

  if (!role) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I couldn't find a role matching "${rawRole}". Try something like "set my role to Senior Account Manager". You can also set it at /connect.`,
          },
        },
      ],
      "Role not found"
    );
    return true;
  }

  const prefs = await loadUserPrefs(userId);
  prefs.defaultRole = role;
  await saveUserPrefs(userId, prefs);

  await postSlackReply(
    channelId,
    [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Role updated to *${role}*. I'll use this when matching your tasks from now on.`,
        },
      },
    ],
    "Role updated"
  );
  return true;
}

// ---------------------------------------------------------------------------
// Day catch-up — "go back to Monday", "catch up on Tuesday", etc.
// ---------------------------------------------------------------------------
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const CATCHUP_PATTERN =
  /\b(?:go back to|catch up on|do|run|show me|redo)\b.*?\b(monday|tuesday|wednesday|thursday|friday)\b/i;

function parseCatchUpDay(text: string): Date | null {
  const match = CATCHUP_PATTERN.exec(text);
  if (!match) return null;

  const dayName = match[1].toLowerCase();
  const targetDow = DAY_NAMES.indexOf(dayName);
  if (targetDow === -1) return null;

  // Find that day within the current Mon-Sun week
  const now = new Date();
  const currentDow = now.getDay(); // 0=Sun, 1=Mon, ...
  const todayDow = currentDow === 0 ? 7 : currentDow; // shift to Mon=1..Sun=7
  const targetShifted = targetDow === 0 ? 7 : targetDow;

  // Only allow past days within the same Mon-Sun week
  if (targetShifted >= todayDow) return null; // can't catch up on today or future

  const diff = todayDow - targetShifted;
  const target = new Date(now);
  target.setDate(target.getDate() - diff);
  target.setHours(0, 0, 0, 0);
  return target;
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function handleCatchUp(
  userId: string,
  channelId: string,
  targetDate: Date
): Promise<void> {
  const dayLabel = targetDate.toLocaleDateString("en-GB", {
    weekday: "long",
  });
  const dateStr = formatDateStr(targetDate);

  // Validate Scoro user ID before checking
  const catchUpPrefs = await loadUserPrefs(userId);
  if (!catchUpPrefs.scoroUserId) {
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: "Your Scoro user ID hasn't been set up yet. Please reconnect at /connect or ask Foluso to set it manually." } }],
      "Missing Scoro user ID"
    );
    return;
  }

  const SCORO_CHECK_FAILED_MSG =
    "Couldn't verify Scoro for that date, so I won't risk a duplicate. Please check manually.";

  // Check if entries already exist for that day
  const entriesCheck = await checkScoroEntriesForDate(dateStr, catchUpPrefs.scoroUserId);
  if (entriesCheck.error) {
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: SCORO_CHECK_FAILED_MSG } }],
      "Scoro check failed"
    );
    return;
  }
  if (entriesCheck.hasEntries) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `You've already got entries logged for ${dayLabel}. I can't touch those; check Scoro directly if something's wrong there.`,
          },
        },
      ],
      `Entries already exist for ${dayLabel}`
    );
    return;
  }

  // Check if the week has been submitted
  const weekCheck = await checkWeekSubmitted(dateStr, catchUpPrefs.scoroUserId);
  if (weekCheck.error) {
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: SCORO_CHECK_FAILED_MSG } }],
      "Scoro check failed"
    );
    return;
  }
  if (weekCheck.submitted) {
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "This week's already submitted in Scoro, so I can't add anything to it.",
          },
        },
      ],
      "Week already submitted"
    );
    return;
  }

  // All clear — run the summary for that date
  await postThinking(channelId);
  try {
    await runCopilotSummary(userId, {
      channelId,
      writeToScoro: false,
      targetDate,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Catch-up summary error:", msg);
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Something went wrong running the summary for ${dayLabel}: ${msg}`,
          },
        },
      ],
      "Catch-up error"
    );
  }
}

// ---------------------------------------------------------------------------
// Loading indicator
// ---------------------------------------------------------------------------
async function postThinking(channelId: string): Promise<void> {
  await postSlackReply(
    channelId,
    [{ type: "section", text: { type: "mrkdwn", text: "\ud83e\udd14 Working on it\u2026" } }],
    "Working on it..."
  );
}

// ---------------------------------------------------------------------------
// End-of-day detection
// ---------------------------------------------------------------------------

// Quick check: does the message contain an obvious time duration?
// If so, it's a time entry, not an end-of-day trigger.
function looksLikeTimeEntry(text: string): boolean {
  return /\d+\s*(h(ours?|rs?|r)?|m(ins?|inutes?)?)\b/i.test(text);
}

async function handleEndOfDay(
  userId: string,
  channelId: string
): Promise<void> {
  await postThinking(channelId);
  try {
    const result = await runCopilotSummary(userId, {
      channelId,
      writeToScoro: false,
    });
    if (result.slackStatus === "skipped: already sent today") {
      await postSlackReply(
        channelId,
        [{ type: "section", text: { type: "mrkdwn", text: "You've already had today's summary. Check your messages above." } }],
        "Already sent today"
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("On-demand summary error:", msg);
    await postSlackReply(
      channelId,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Something went wrong running your summary: ${msg}`,
          },
        },
      ],
      "Summary error"
    );
  }
}

// ---------------------------------------------------------------------------
// "Done" intent — user is confirming they're finished, finalise entries
// ---------------------------------------------------------------------------
async function handleDoneConfirm(
  userId: string,
  channelId: string
): Promise<void> {
  const convo = await loadConversation(userId);
  if (!convo) {
    // No active session; treat as summary request instead
    await handleEndOfDay(userId, channelId);
    return;
  }

  const approvedDrafts = convo.drafts.filter((d) => d.approved);
  if (approvedDrafts.length === 0) {
    await clearConversation(userId);
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: "\u2705 No entries to write. Session closed." } }],
      "Session closed"
    );
    return;
  }

  // Validate Scoro user ID before writing
  const donePrefs = await loadUserPrefs(userId);
  if (!donePrefs.scoroUserId) {
    await postSlackReply(
      channelId,
      [{ type: "section", text: { type: "mrkdwn", text: "Your Scoro user ID hasn't been set up yet. Please reconnect at /connect or ask Foluso to set it manually." } }],
      "Missing Scoro user ID"
    );
    return;
  }

  await postThinking(channelId);

  const results = await finaliseAndWrite(convo, donePrefs.scoroUserId);

  // Save confirmed event->project mappings for future memory
  for (const d of approvedDrafts) {
    if (!d.startDatetime || !d.projectId) continue;
    await saveEventMapping(userId, d.eventTitle, {
      project_id: d.projectId,
      project_name: d.projectName || "",
      task_id: d.taskId,
      task_title: d.taskTitle,
    });
  }

  await clearConversation(userId);

  const written = results.filter((r) => !r.error && r.action !== "skipped" && r.action !== "failed");
  const failed = results.filter((r) => r.error);

  let summary = `\u2705 Done. ${written.length} entry${written.length === 1 ? "" : "s"} written to Scoro:\n`;
  summary += written
    .map(
      (r) =>
        `\u2022 ${r.durationMinutes < 60 ? `${r.durationMinutes}m` : `${Math.floor(r.durationMinutes / 60)}h${r.durationMinutes % 60 > 0 ? ` ${r.durationMinutes % 60}m` : ""}`} ${r.projectName || "unknown"} (${r.action})`
    )
    .join("\n");

  if (failed.length > 0) {
    summary += `\n\n\u26a0\ufe0f ${failed.length} failed:\n`;
    summary += failed
      .map((r) => `\u2022 ${r.eventTitle}: ${r.error}`)
      .join("\n");
  }

  summary += "\n\nAll done. Have a good evening!";

  await postSlackReply(
    channelId,
    [{ type: "section", text: { type: "mrkdwn", text: summary } }],
    summary
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
      // Check for pause/resume or delivery time before anything else
      if (await handlePauseResume(userId, channelId, text)) return;
      if (await handleDeliveryTime(userId, channelId, text)) return;
      if (await handleRoleChange(userId, channelId, text)) return;

      // Check for day catch-up ("go back to Monday", etc.)
      const catchUpDate = parseCatchUpDay(text);
      if (catchUpDate) {
        await handleCatchUp(userId, channelId, catchUpDate);
        return;
      }

      // If the message doesn't look like a time entry, check if it's
      // an end-of-day intent (via AI). This runs before conversation
      // state so "log my day" / "wrap up" / "done" works even mid-session.
      if (!looksLikeTimeEntry(text)) {
        const intent = await classifyEndOfDayIntent(text);
        if (intent === "summary") {
          await handleEndOfDay(userId, channelId);
          return;
        }
        if (intent === "done") {
          await handleDoneConfirm(userId, channelId);
          return;
        }
      }

      const convo = await loadConversation(userId);
      if (convo && convo.step === "editing") {
        await postThinking(channelId);
        await handleFreeTextEntry(userId, channelId, text);
      } else if (convo && convo.step === "fixing") {
        await postThinking(channelId);
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
