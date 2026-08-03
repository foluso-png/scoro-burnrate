import { NextRequest, NextResponse } from "next/server";
import { loadUserPrefs, saveUserPrefs } from "@/lib/user-prefs";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { slackId, defaultRole, scoroUserId } = body;

  if (!slackId || typeof slackId !== "string") {
    return NextResponse.json({ error: "Missing slackId" }, { status: 400 });
  }

  const prefs = await loadUserPrefs(slackId);

  if (typeof defaultRole === "string" || defaultRole === null) {
    prefs.defaultRole = defaultRole;
  }

  if (typeof scoroUserId === "number" || scoroUserId === null) {
    prefs.scoroUserId = scoroUserId;
  }

  await saveUserPrefs(slackId, prefs);
  return NextResponse.json({ ok: true, prefs });
}
