function formatMb(bytes) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
}

function getActiveHandleCount() {
  if (typeof process._getActiveHandles !== "function") return null;
  return process._getActiveHandles().length;
}

function createMemoryMonitor({ logger, intervalMs = 0 } = {}) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return {
      start() {},
      stop() {}
    };
  }

  let timer = null;

  const logMemory = () => {
    const memory = process.memoryUsage();
    const handles = getActiveHandleCount();
    logger?.info(
      `Memory: pid=${process.pid} rss=${formatMb(memory.rss)} heapUsed=${formatMb(
        memory.heapUsed
      )} heapTotal=${formatMb(memory.heapTotal)} external=${formatMb(memory.external)} handles=${
        handles ?? "n/a"
      }`
    );
  };

  return {
    start() {
      if (timer) return;
      logMemory();
      timer = setInterval(logMemory, ms);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { createMemoryMonitor };
