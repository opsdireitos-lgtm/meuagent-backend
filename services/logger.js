const { query } = require("../config/database");

async function log(level, source, message, metadata = null) {
  try {
    await query(
      "INSERT INTO logs (level, source, message, metadata) VALUES ($1, $2, $3, $4)",
      [level, source, message, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error(`[Logger] Failed to write log: ${err.message}`);
  }
  const prefix = `[${source}]`;
  if (level === "error") console.error(prefix, message, metadata || "");
  else if (level === "warn") console.warn(prefix, message, metadata || "");
  else console.log(prefix, message);
}

module.exports = {
  info: (source, msg, meta) => log("info", source, msg, meta),
  warn: (source, msg, meta) => log("warn", source, msg, meta),
  error: (source, msg, meta) => log("error", source, msg, meta),
};
