const levels = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(levelName = "info") {
  const threshold = levels[levelName] || levels.info;

  function write(level, message, meta) {
    if (levels[level] < threshold) return;

    const stamp = new Date().toISOString();
    const extra = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[${stamp}] ${level.toUpperCase()} ${message}${extra}`);
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}

module.exports = { createLogger };
