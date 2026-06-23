import { NextRequest, NextResponse } from "next/server";
import { saveTokens, UserTokenRecord } from "@/lib/google-auth";

/**
 * Resolve the Slack member ID for a Google email address.
 * Uses Slack's users.lookupByEmail API.
 *
 * TEMP FALLBACK: If the lookup fails (e.g. bot lacks users:read.email scope),
 * falls back to the SLACK_USER_ID env var. Remove this once the Slack app has
 * the users:read.email scope enabled in production.
 */
async function resolveSlackId(email: string): Promise<string> {
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (slackToken) {
    try {
      const res = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${slackToken}` } }
      );
      const data = await res.json();
      if (data.ok && data.user?.id) {
        return data.user.id as string;
      }
      console.warn(
        `Slack lookupByEmail failed for ${email}: ${data.error || "unknown error"}`
      );
    } catch (err) {
      console.warn(
        `Slack lookupByEmail threw for ${email}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // TEMP: fall back to env var until users:read.email scope is live
  const fallback = process.env.SLACK_USER_ID;
  if (!fallback) {
    throw new Error(
      "Could not resolve Slack ID: lookupByEmail failed and SLACK_USER_ID is not set"
    );
  }
  console.warn(`Using SLACK_USER_ID fallback (${fallback}) for ${email}`);
  return fallback;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const storedState = request.cookies.get("oauth_state")?.value;

  if (!state || !storedState || state !== storedState) {
    const url = new URL("/connect", request.url);
    url.searchParams.set("status", "error");
    url.searchParams.set("message", "Invalid state parameter (CSRF check failed)");
    return NextResponse.redirect(url);
  }

  if (!code) {
    const url = new URL("/connect", request.url);
    url.searchParams.set("status", "error");
    url.searchParams.set("message", "No authorisation code received from Google");
    return NextResponse.redirect(url);
  }

  try {
    // 1. Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI!,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
    }

    const tokenData = await tokenRes.json();

    // 2. Fetch Google userinfo for email and name
    const userinfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    if (!userinfoRes.ok) {
      const body = await userinfoRes.text();
      throw new Error(`Userinfo fetch failed: ${userinfoRes.status} ${body}`);
    }

    const userinfo = await userinfoRes.json();
    const email: string = userinfo.email;
    const name: string = userinfo.name || email;

    // 3. Resolve Slack member ID from email
    const slackId = await resolveSlackId(email);

    // 4. Save per-user token record
    const record: UserTokenRecord = {
      googleTokens: {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        scope: tokenData.scope,
        expiry_date: Date.now() + tokenData.expires_in * 1000,
      },
      email,
      name,
    };
    await saveTokens(slackId, record);

    const url = new URL("/connect", request.url);
    url.searchParams.set("status", "success");

    const response = NextResponse.redirect(url);
    response.cookies.set("oauth_state", "", {
      httpOnly: true,
      secure: false,
      maxAge: 0,
      path: "/",
    });
    return response;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token exchange failed";
    const url = new URL("/connect", request.url);
    url.searchParams.set("status", "error");
    url.searchParams.set("message", message);
    return NextResponse.redirect(url);
  }
}
