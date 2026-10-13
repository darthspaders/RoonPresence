const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { acquireSingleInstanceLock } = require("../src/singleInstance");

function createTempLockPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, ".roonpresence.lock");
}

function createLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      error: (message, meta) => entries.push({ level: "error", message, meta }),
      warn: (message, meta) => entries.push({ level: "warn", message, meta })
    }
  };
}

test("acquires and releases a single instance lock", (t) => {
  const lockPath = createTempLockPath(t);
  const release = acquireSingleInstanceLock({ lockPath, pid: process.pid });

  assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);

  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("refuses a lock owned by a running process", (t) => {
  const lockPath = createTempLockPath(t);
  const { entries, logger } = createLogger();
  fs.writeFileSync(lockPath, `${process.pid}\n`, "utf8");

  const release = acquireSingleInstanceLock({
    lockPath,
    pid: process.pid + 100000,
    logger
  });

  assert.equal(release, null);
  assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
  assert.match(entries.find((entry) => entry.level === "error")?.message, /already running/);
});

test("replaces a stale single instance lock", (t) => {
  const lockPath = createTempLockPath(t);
  const { entries, logger } = createLogger();
  fs.writeFileSync(lockPath, "99999999\n", "utf8");

  const release = acquireSingleInstanceLock({ lockPath, pid: process.pid, logger });

  assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
  assert.match(entries.find((entry) => entry.level === "warn")?.message, /stale/);

  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("release leaves a lock owned by another pid alone", (t) => {
  const lockPath = createTempLockPath(t);
  const release = acquireSingleInstanceLock({ lockPath, pid: process.pid });
  fs.writeFileSync(lockPath, "67890\n", "utf8");

  release();

  assert.equal(fs.readFileSync(lockPath, "utf8"), "67890\n");
});
