const IORedis = require("ioredis");

const redis = new IORedis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redis.on("connect", () => console.log("[Redis] Connected"));
redis.on("error", (err) => console.error("[Redis] Error:", err.message));

// ── Deduplication ──
const DEDUP_TTL = 120;

async function isDuplicate(messageId) {
  if (!messageId) return false;
  const result = await redis.set(`dedup:${messageId}`, "1", "EX", DEDUP_TTL, "NX");
  return result === null;
}

// ── AI Lock per phone ──
const AI_LOCK_TTL = 120;

async function tryAcquireAILock(agentId, phone) {
  const key = `ai_lock:${agentId}:${phone}`;
  const result = await redis.set(key, Date.now().toString(), "EX", AI_LOCK_TTL, "NX");
  return result === "OK";
}

async function releaseAILock(agentId, phone) {
  await redis.del(`ai_lock:${agentId}:${phone}`);
}

module.exports = { redis, isDuplicate, tryAcquireAILock, releaseAILock };
