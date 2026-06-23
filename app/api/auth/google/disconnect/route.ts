import { NextRequest, NextResponse } from "next/server";
import { deleteTokens } from "@/lib/google-auth";

export async function POST(request: NextRequest) {
  // TEMP: use SLACK_USER_ID fallback until multi-user session is in place
  const slackId = process.env.SLACK_USER_ID;
  if (!slackId) {
    return NextResponse.json(
      { error: "SLACK_USER_ID is not configured" },
      { status: 500 }
    );
  }

  await deleteTokens(slackId);
  return NextResponse.redirect(new URL("/connect", request.url));
}
