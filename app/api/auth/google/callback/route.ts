import { NextRequest, NextResponse } from "next/server";
import { saveTokens, UserTokenRecord } from "@/lib/google-auth";
import { loadUserPrefs, saveUserPrefs } from "@/lib/user-prefs";
import { scoroPost } from "@/lib/matcher";

/**
 * Resolve the Slack member ID for a Google email address.
 * Uses Slack's users.lookupByEmail API (requires users:read.email scope).
 *
 * If the lookup fails, we throw rather than silently storing tokens under
 * the wrong user, which would send someone else's timesheet to them.
 */
async function resolveSlackId(email: string): Promise<string> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    throw new Error(
      "SLACK_BOT_TOKEN is not configured. Please contact Foluso."
    );
  }

  const res = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${slackToken}` } }
  );
  const data = await res.json();

  if (data.ok && data.user?.id) {
    return data.user.id as string;
  }

  const slackError = data.error || "unknown error";
  console.error(
    `Slack lookupByEmail failed for ${email}: ${slackError}`
  );
  throw new Error(
    `Could not find your Slack account (${email}). Please contact Foluso so he can sort it out.`
  );
}

/**
 * Look up a Scoro user ID by email address.
 * Returns the numeric ID if found, or null if no match.
 */
async function resolveScoroUserId(email: string): Promise<number | null> {
  try {
    interface ScoroUserRecord {
      id: number;
      email?: string;
      username?: string;
      [key: string]: unknown;
    }
    const res = await scoroPost<ScoroUserRecord[]>("/users/list", {
      per_page: 500,
      page: 1,
    });
    const users = Array.isArray(res.data) ? res.data : [];
    const emailLower = email.toLowerCase();
    const match = users.find(
      (u) =>
        (u.email && u.email.toLowerCase() === emailLower) ||
        (u.username && u.username.toLowerCase() === emailLower)
    );
    return match ? match.id : null;
  } catch (err) {
    console.error("Failed to resolve Scoro user ID:", err);
    return null;
  }
}

/**
 * Send a plain text DM to a Slack user via chat.postMessage.
 * Posting to a user ID as the channel opens a DM automatically.
 */
async function sendSlackDM(slackId: string, text: string): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: slackId, text }),
    });
  } catch (err) {
    console.error("Failed to send Slack DM:", err);
  }
}

/**
 * Send the one-time welcome DM with Block Kit formatting.
 */
async function sendWelcomeDM(
  slackId: string,
  firstName: string
): Promise<void> {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\ud83d\udc4b Hey ${firstName}, welcome to your new timesheet co-pilot!\n\nThink of me as your personal assistant for Scoro, minus the coffee runs \u2615\ufe0f. I'll check your calendar and match your meetings to the right projects, then send you a draft every evening around 5pm. Prefer a different time? Just message me something like "send my summary at 6pm".`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*A few things worth knowing:*\n\ud83d\udc40 I review your calendar, I don't watch it \u2014 just a once-a-day look, no live tracking\n\u2705 Nothing hits Scoro until you say yes\n\u26a1 Fancy trying it right now? Just type "log my day"`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "\ud83d\udccc Pin this chat so you can find me easily next time",
        },
      ],
    },
  ];

  const fallbackText = `\ud83d\udc4b Hey ${firstName}, welcome to your new timesheet co-pilot! Type "log my day" to get started.`;

  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: slackId,
        text: fallbackText,
        blocks,
      }),
    });
  } catch (err) {
    console.error("Failed to send welcome DM:", err);
  }
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

    // Resolve and store Scoro user ID
    const scoroUserId = await resolveScoroUserId(email);
    const prefs = await loadUserPrefs(slackId);

    if (scoroUserId) {
      prefs.scoroUserId = scoroUserId;
      await saveUserPrefs(slackId, prefs);

      // Send one-time welcome DM (only on first connect, not reconnects)
      if (!prefs.hasReceivedWelcome) {
        const firstName = name.split(" ")[0] || name;
        await sendWelcomeDM(slackId, firstName);
        prefs.hasReceivedWelcome = true;
        await saveUserPrefs(slackId, prefs);
      }
    } else {
      // Scoro account not found — warn but don't block the connection
      console.warn(`No Scoro user found for ${email}`);
      await sendSlackDM(
        slackId,
        `I've connected your Google Calendar, but I couldn't find a Scoro account matching ${email}. Ask Foluso to set your Scoro user ID manually so I can start logging your time.`
      );
    }

    const url = new URL("/connect", request.url);
    url.searchParams.set("status", "success");
    url.searchParams.set("email", email);
    url.searchParams.set("name", name);
    url.searchParams.set("sid", slackId);

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
