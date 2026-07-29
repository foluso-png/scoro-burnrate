import "server-only";

const useUpstash = !!(
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
);

export interface LastRunRecord {
  timestamp: string; // ISO 8601
  status: "ok" | "error";
  entryCount: number; // number of entries written to Scoro
  error?: string;
}

function redisKey(slackId: string): string {
  return `last_run:${slackId}`;
}

async function getRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

export async function saveLastRun(
  slackId: string,
  record: LastRunRecord
): Promise<void> {
  if (!useUpstash) return;
  const redis = await getRedis();
  await redis.set(redisKey(slackId), JSON.stringify(record));
}

export async function loadLastRun(
  slackId: string
): Promise<LastRunRecord | null> {
  if (!useUpstash) return null;
  const redis = await getRedis();
  const raw = await redis.get<string>(redisKey(slackId));
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}
