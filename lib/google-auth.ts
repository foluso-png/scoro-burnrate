import "server-only";
import fs from "fs";
import path from "path";

const TOKENS_PATH = path.join(process.cwd(), "data", "google-tokens.json");
const REDIS_KEY = "google_tokens";

const useUpstash = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

async function getRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

export async function saveTokens(tokens: Record<string, unknown>) {
  if (useUpstash) {
    const redis = await getRedis();
    await redis.set(REDIS_KEY, JSON.stringify(tokens));
  } else {
    const dir = path.dirname(TOKENS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), {
      mode: 0o600,
    });
  }
}

export async function loadTokens(): Promise<Record<string, unknown> | null> {
  if (useUpstash) {
    const redis = await getRedis();
    const raw = await redis.get<string>(REDIS_KEY);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } else {
    if (!fs.existsSync(TOKENS_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(TOKENS_PATH, "utf-8");
    return JSON.parse(raw);
  }
}

export async function isConnected(): Promise<boolean> {
  const tokens = await loadTokens();
  return tokens !== null && typeof tokens.refresh_token === "string";
}

export async function deleteTokens() {
  if (useUpstash) {
    const redis = await getRedis();
    await redis.del(REDIS_KEY);
  } else {
    if (fs.existsSync(TOKENS_PATH)) {
      fs.unlinkSync(TOKENS_PATH);
    }
  }
}

export async function getAccessToken(): Promise<string> {
  const tokens = await loadTokens();
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
  await saveTokens(updated);

  return data.access_token as string;
}
