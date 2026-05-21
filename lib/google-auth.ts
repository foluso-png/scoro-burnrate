import "server-only";
import fs from "fs";
import path from "path";

const TOKENS_PATH = path.join(process.cwd(), "data", "google-tokens.json");

export function saveTokens(tokens: Record<string, unknown>) {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

export function loadTokens(): Record<string, unknown> | null {
  if (!fs.existsSync(TOKENS_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(TOKENS_PATH, "utf-8");
  return JSON.parse(raw);
}

export function isConnected(): boolean {
  const tokens = loadTokens();
  return tokens !== null && typeof tokens.refresh_token === "string";
}

export function deleteTokens() {
  if (fs.existsSync(TOKENS_PATH)) {
    fs.unlinkSync(TOKENS_PATH);
  }
}

export async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google Calendar is not connected");
  }

  const expiryDate = tokens.expiry_date as number | undefined;
  if (tokens.access_token && expiryDate && Date.now() < expiryDate - 60_000) {
    return tokens.access_token as string;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token as string,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();

  const updated: Record<string, unknown> = {
    ...tokens,
    access_token: data.access_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  if (data.refresh_token) {
    updated.refresh_token = data.refresh_token;
  }
  saveTokens(updated);

  return data.access_token as string;
}
