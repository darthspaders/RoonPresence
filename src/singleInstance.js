const fs = require("fs");
const path = require("path");

const DEFAULT_LOCK_PATH = path.join(__dirname, "..", ".roonpresence.lock");

function parsePid(value) {
  const pid = Number(String(value || "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function createLock(lockPath, pid, logger) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, "wx");

  try {
    fs.writeFileSync(fd, `${pid}\n`, "utf8");
  } finally {
    fs.closeSync(fd);
  }

  let released = false;
  return function releaseSingleInstanceLock() {
    if (released) return;
    released = true;

    try {
      const lockedPid = parsePid(fs.readFileSync(lockPath, "utf8"));
      if (lockedPid === pid) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logger?.warn?.("Failed to release RoonPresence instance lock", {
          error: error.message
        });
      }
    }
  };
}

function acquireSingleInstanceLock({
  lockPath = DEFAULT_LOCK_PATH,
  pid = process.pid,
  logger
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id for instance lock: ${pid}`);
  }

  try {
    return createLock(lockPath, pid, logger);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let existingPid = null;
  try {
    existingPid = parsePid(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (existingPid && isProcessRunning(existingPid)) {
    logger?.error?.(
      `RoonPresence is already running with pid ${existingPid}. Stop that process before starting another copy.`
    );
    return null;
  }

  logger?.warn?.(
    existingPid
      ? `Removing stale RoonPresence instance lock for pid ${existingPid}`
      : "Removing invalid RoonPresence instance lock"
  );

  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    return createLock(lockPath, pid, logger);
  } catch (error) {
    if (error?.code === "EEXIST") {
      logger?.error?.("Another RoonPresence instance acquired the lock first.");
      return null;
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_LOCK_PATH,
  acquireSingleInstanceLock,
  isProcessRunning
};
