const { redis } = require("../config/redis");
const { testConnection } = require("../config/database");
const { webhookCircuit, followUpCircuit, bulkCircuit } = require("../services/circuit-breaker");

async function healthController(req, res) {
  const dbOk = await testConnection();

  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      postgres: dbOk ? "connected" : "disconnected",
      redis: redis.status,
    },
    circuits: {
      webhook: webhookCircuit.getState(),
      followUp: followUpCircuit.getState(),
      bulk: bulkCircuit.getState(),
    },
  });
}

module.exports = { healthController };
