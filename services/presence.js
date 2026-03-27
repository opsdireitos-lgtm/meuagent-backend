const { sendPresence } = require("./evolution-api");

const PRESENCE_STEP_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function estimateTypingDelayMs(text) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  const charCount = normalized.length;
  const wordCount = normalized ? normalized.split(" ").length : 0;
  if (charCount === 0) return 1000;
  return clamp(900 + charCount * 55 + wordCount * 120, 1000, 18000);
}

function estimateSpeechFromTextMs(text) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  const wordCount = normalized ? normalized.split(" ").length : 0;
  if (wordCount === 0) return 2000;
  return clamp(1500 + wordCount * 650, 2000, 45000);
}

function estimateAudioSendTailMs(referenceMs) {
  return clamp(3000 + Math.round(referenceMs * 0.12), 3000, 12000);
}

async function waitWithPresence(agent, phone, presence, totalMs) {
  const waitMs = Math.max(0, Math.round(totalMs));
  if (waitMs === 0) return;

  if (!agent.typing_simulation) {
    await sleep(waitMs);
    return;
  }

  await sendPresence(agent, phone, presence, Math.min(waitMs, 5000));

  let elapsed = 0;
  while (elapsed < waitMs) {
    const step = Math.min(PRESENCE_STEP_MS, waitMs - elapsed);
    await sleep(step);
    elapsed += step;
    if (elapsed < waitMs) {
      await sendPresence(agent, phone, presence, Math.min(5000, waitMs - elapsed));
    }
  }
}

function startPresenceHeartbeat(agent, phone, presence) {
  if (!agent?.typing_simulation) return () => {};

  let stopped = false;
  let timer = null;

  sendPresence(agent, phone, presence, 5000).catch(() => {});

  const pulse = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      await sendPresence(agent, phone, presence, 5000).catch(() => {});
      pulse();
    }, PRESENCE_STEP_MS);
  };

  pulse();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function runWithPresence(agent, phone, presence, minimumMs, task, tailMs = 0) {
  const startedAt = Date.now();
  const ensureMinimumMs = async (targetMs) => {
    const safeTargetMs = Math.max(0, Math.round(targetMs));
    const elapsedMs = Date.now() - startedAt;
    if (safeTargetMs > elapsedMs) {
      await sleep(safeTargetMs - elapsedMs);
    }
  };

  if (!agent?.typing_simulation) {
    await ensureMinimumMs(minimumMs);
    const result = await task({ ensureMinimumMs, startedAt });
    if (tailMs > 0) await sleep(Math.round(tailMs));
    return result;
  }

  const stopPresence = startPresenceHeartbeat(agent, phone, presence);

  try {
    await ensureMinimumMs(minimumMs);
    const result = await task({ ensureMinimumMs, startedAt });
    if (tailMs > 0) await sleep(Math.round(tailMs));
    return result;
  } finally {
    stopPresence();
  }
}

module.exports = {
  sleep, clamp, estimateTypingDelayMs, estimateSpeechFromTextMs,
  estimateAudioSendTailMs, waitWithPresence, startPresenceHeartbeat,
  runWithPresence,
};
