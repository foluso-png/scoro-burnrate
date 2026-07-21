import "server-only";

let redisInstance: Awaited<ReturnType<typeof createRedis>> | null = null;

async function createRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
  });
}

export async function getRedis() {
  if (!redisInstance) {
    redisInstance = await createRedis();
  }
  return redisInstance;
}
