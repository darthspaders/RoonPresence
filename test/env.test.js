const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readDotEnvFile } = require("../src/env");

test("reads quoted dotenv values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roon-discord-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(
    file,
    [
      "HQPLAYER_SIGNAL_PATH_PREFIX=poly-sinc-gauss-hires-mp, TPDF, PCM",
      'HQPLAYER_RATE_COMMAND="C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --state',
      "MEMORY_LOG_MS=300000"
    ].join("\n")
  );

  assert.deepEqual(readDotEnvFile(file), {
    HQPLAYER_SIGNAL_PATH_PREFIX: "poly-sinc-gauss-hires-mp, TPDF, PCM",
    HQPLAYER_RATE_COMMAND:
      '"C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --state',
    MEMORY_LOG_MS: "300000"
  });
});
