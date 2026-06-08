import { NextRequest, NextResponse } from "next/server";
import { saveTokens } from "@/lib/google-auth";

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
    const res = await fetch("https://oauth2.googleapis.com/token", {
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

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${body}`);
    }

    const data = await res.json();

    const tokens: Record<string, unknown> = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      scope: data.scope,
      expiry_date: Date.now() + data.expires_in * 1000,
    };
    await saveTokens(tokens);

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
