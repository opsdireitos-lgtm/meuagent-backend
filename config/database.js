const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[PostgreSQL] Unexpected error:", err.message);
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`[PostgreSQL] Slow query (${duration}ms):`, text.substring(0, 80));
  }
  return result;
}

async function testConnection() {
  try {
    await pool.query("SELECT NOW()");
    console.log("[PostgreSQL] Connected successfully");
    return true;
  } catch (err) {
    console.error("[PostgreSQL] Connection failed:", err.message);
    return false;
  }
}

module.exports = { pool, query, testConnection };
