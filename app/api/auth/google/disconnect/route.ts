import { NextRequest, NextResponse } from "next/server";
import { deleteTokens } from "@/lib/google-auth";

export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.json(
      { error: "Missing email parameter" },
      { status: 400 }
    );
  }

  // Look up Slack ID from email
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json(
      { error: "SLACK_BOT_TOKEN is not configured" },
      { status: 500 }
    );
  }

  const res = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${slackToken}` } }
  );
  const data = await res.json();

  if (!data.ok || !data.user?.id) {
    const slackError = data.error || "unknown error";
    console.error(
      `Slack lookupByEmail failed for ${email}: ${slackError}`
    );
    return NextResponse.json(
      { error: `Could not find Slack account for ${email}. Please contact Foluso.` },
      { status: 404 }
    );
  }

  const slackId: string = data.user.id;
  await deleteTokens(slackId);

  return NextResponse.redirect(new URL("/connect", request.url));
}
