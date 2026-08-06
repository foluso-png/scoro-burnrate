// Slack external_select options endpoint.
// Receives a search query from the dropdown and returns matching projects.

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getProjectLookup } from "@/lib/matcher";

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

// Strip client legal suffixes like "(Wella UK LTD)" from the display label
const LEGAL_SUFFIX_RE =
  /\s*\((?:[^)]*\b(?:ltd|limited|llc|inc|plc|gmbh|ag|s\.?a\.?|b\.?v\.?|co\.?)\b[^)]*)\)/gi;

function shortenLabel(projectName: string, clientName: string): string {
  const projLower = projectName.toLowerCase();
  const clientLower = clientName.toLowerCase();

  let label = projectName;
  if (clientName && !projLower.includes(clientLower)) {
    label = `${projectName} (${clientName})`;
  }

  label = label.replace(LEGAL_SUFFIX_RE, "");
  return label.slice(0, 75);
}

export async function POST(request: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ options: [] }, { status: 500 });
  }

  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return NextResponse.json({ options: [] }, { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return NextResponse.json({ options: [] }, { status: 400 });
  }

  const payload = JSON.parse(payloadStr);
  const query = (payload.value || "").toLowerCase().trim();
  const actionId = payload.action_id || "";

  if (actionId !== "select_project") {
    return NextResponse.json({ options: [] });
  }

  const lookup = await getProjectLookup();
  const activeProjects = lookup.projects.filter(
    (p) => p.status === "inprogress"
  );

  const options: Array<{ text: { type: string; text: string }; value: string }> = [];

  for (const p of activeProjects) {
    if (p.tasks.length === 0) continue;

    const label = shortenLabel(p.name, p.client_name);
    const searchable = `${p.name} ${p.client_name}`.toLowerCase();

    if (query && !searchable.includes(query)) continue;

    options.push({
      text: { type: "plain_text", text: label },
      value: String(p.project_id),
    });

    if (options.length >= 99) break;
  }

  options.push({
    text: { type: "plain_text", text: "Skip this event" },
    value: "skip",
  });

  return NextResponse.json({ options });
}
