// ══════════════════════════════════════════════════════════════
// MeuAgent VPS Backend - server.js
// Production-ready: Express + PostgreSQL + Redis + Workers
// ══════════════════════════════════════════════════════════════

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { testConnection } = require("./config/database");
const { redis } = require("./config/redis");
const { registerRoutes } = require("./routes");
const { startFollowUpWorker, stopFollowUpWorker } = require("./workers/follow-up-worker");
const { startBulkWorker, stopBulkWorker } = require("./workers/bulk-worker");

const PORT = parseInt(process.env.PORT || "3333");

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── Routes ──
registerRoutes(app);

// ── Startup ──
async function start() {
  // Wait for PostgreSQL
  let pgReady = false;
  for (let i = 0; i < 15; i++) {
    pgReady = await testConnection();
    if (pgReady) break;
    console.log(`[Startup] Waiting for PostgreSQL... (${i + 1}/15)`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!pgReady) {
    console.error("[Startup] PostgreSQL not available after 30s. Starting anyway (logs to console only).");
  }

  // Wait for Redis
  let redisReady = redis.status === "ready";
  if (!redisReady) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (redis.status === "ready") { redisReady = true; break; }
    }
  }

  if (!redisReady) {
    console.error("[Startup] Redis not ready. Deduplication may not work.");
  }

  // Start HTTP server
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   MeuAgent VPS Backend v2.0 — PRODUCTION        ║
║──────────────────────────────────────────────────║
║   Port:       ${PORT}                                ║
║   PostgreSQL: ${pgReady ? "✅ Connected" : "❌ Offline "}                    ║
║   Redis:      ${redisReady ? "✅ Connected" : "❌ Offline "}                    ║
║   Supabase:   ✅ Configured                      ║
║──────────────────────────────────────────────────║
║   Routes:                                        ║
║     GET  /health                                 ║
║     POST /webhook                                ║
║     POST /message/send                           ║
║     POST /execute-flow                           ║
║──────────────────────────────────────────────────║
║   Workers:                                       ║
║     ✅ Follow-up processor                       ║
║     ✅ Bulk campaign processor                   ║
╚══════════════════════════════════════════════════╝
    `);

    // Start background workers
    startFollowUpWorker();
    startBulkWorker();
  });
}

// ── Graceful Shutdown ──
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  stopFollowUpWorker();
  stopBulkWorker();
  redis.quit();
  const { pool } = require("./config/database");
  pool.end().then(() => {
    console.log("[Shutdown] All connections closed. Bye!");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  shutdown("UNCAUGHT");
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

// ── Start! ──
start();
