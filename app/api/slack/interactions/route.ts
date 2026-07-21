// Required env vars:
//   SLACK_SIGNING_SECRET - Slack app signing secret for request verification

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

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

  // Log the interaction
  const user = payload.user?.username || payload.user?.id || "unknown";
  const userId = payload.user?.id || "unknown";
  const actions = payload.actions || [];

  for (const action of actions) {
    console.log(
      `Slack interaction: user=${user} (${userId}) action_id=${action.action_id} value=${action.value ?? action.selected_option?.value ?? "none"}`
    );
  }

  // Acknowledge within 3 seconds — Slack requires a 200 response promptly
  return NextResponse.json({ text: "Got it, processing..." });
}
