const assert = require("node:assert/strict");
const test = require("node:test");
const { isPlaceholder, maskSecret, serializeEnv } = require("../scripts/setup");

test("setup masks existing secrets", () => {
  assert.equal(maskSecret("1234567890abcdef"), "1234...cdef");
  assert.equal(maskSecret(""), "");
});

test("setup serializes env without breaking quoted HQPlayer command", () => {
  const env = serializeEnv({
    DISCORD_CLIENT_ID: "123",
    HQPLAYER_RATE_COMMAND: '"C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --state'
  });

  assert.match(
    env,
    /HQPLAYER_RATE_COMMAND="C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control\.exe" localhost --state/
  );
  assert.match(env, /DISCORD_CLIENT_ID=123/);
});

test("setup detects placeholder values", () => {
  assert.equal(isPlaceholder("your_discord_application_client_id"), true);
  assert.equal(isPlaceholder("123456789012345678"), false);
});

