import "server-only";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

const useUpstash = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

// ---------------------------------------------------------------------------
// Per-user token shape stored in Upstash / local file
// ---------------------------------------------------------------------------
export interface UserTokenRecord {
  googleTokens: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    scope: string;
    expiry_date: number;
  };
  email: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Redis / file helpers
// ---------------------------------------------------------------------------
function redisKey(slackId: string): string {
  return `tokens:${slackId}`;
}

function localPath(slackId: string): string {
  return path.join(DATA_DIR, `tokens-${slackId}.json`);
}

async function getRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

// ---------------------------------------------------------------------------
// Public API — all keyed by Slack member ID
// ---------------------------------------------------------------------------
export async function saveTokens(
  slackId: string,
  record: UserTokenRecord
) {
  if (useUpstash) {
    const redis = await getRedis();
    await redis.set(redisKey(slackId), JSON.stringify(record));
  } else {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(localPath(slackId), JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
  }
}

export async function loadTokens(
  slackId: string
): Promise<UserTokenRecord | null> {
  if (useUpstash) {
    const redis = await getRedis();
    const raw = await redis.get<string>(redisKey(slackId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } else {
    const fp = localPath(slackId);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf-8");
    return JSON.parse(raw);
  }
}

export async function deleteTokens(slackId: string) {
  if (useUpstash) {
    const redis = await getRedis();
    await redis.del(redisKey(slackId));
  } else {
    const fp = localPath(slackId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
}

export async function getAccessToken(slackId: string): Promise<string> {
  const record = await loadTokens(slackId);
  if (!record || !record.googleTokens.refresh_token) {
    throw new Error(`Google Calendar is not connected for user ${slackId}`);
  }

  const { googleTokens } = record;

  if (
    googleTokens.access_token &&
    googleTokens.expiry_date &&
    Date.now() < googleTokens.expiry_date - 60_000
  ) {
    return googleTokens.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: googleTokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();

  const updatedTokens = {
    ...googleTokens,
    access_token: data.access_token as string,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  if (data.refresh_token) {
    updatedTokens.refresh_token = data.refresh_token as string;
  }

  await saveTokens(slackId, {
    ...record,
    googleTokens: updatedTokens,
  });

  return data.access_token as string;
}
