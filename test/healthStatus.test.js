const assert = require("node:assert/strict");
const test = require("node:test");
const { HealthStatus } = require("../src/healthStatus");

function createConfig(overrides = {}) {
  return {
    discordClientId: "123",
    hqplayerZoneMatch: "HQPlayer",
    hqplayer: {
      rateCommand: "hqp5-control localhost --state",
      statusCommand: "",
      signalPathStatic: ""
    },
    albumArt: {
      publicBaseUrl: "",
      proxyPort: 8787
    },
    memoryLogMs: 300000,
    roon: {
      display_name: "RoonPresence"
    },
    ...overrides
  };
}

test("health status logs startup checks", () => {
  const logs = [];
  const health = new HealthStatus({
    config: createConfig(),
    logger: {
      info: (message, meta) => logs.push({ message, meta })
    }
  });

  health.logStartup();

  assert.equal(logs[0].message, "Startup health check");
  assert.equal(logs[0].meta.discordClientId, "set");
  assert.equal(logs[0].meta.hqplayerRateCommand, "yes");
  assert.equal(logs[0].meta.albumArtPublicUrl, "no");
});

test("health status only repeats unchanged status when metadata is supplied", () => {
  const logs = [];
  const health = new HealthStatus({
    config: createConfig(),
    logger: {
      info: (message, meta) => logs.push({ message, meta })
    }
  });

  health.update("discord", "connected");
  health.update("discord", "connected");
  health.update("discord", "connected", { reconnect: true });

  assert.equal(logs.length, 2);
  assert.equal(logs[0].message, "Health: discord connected");
  assert.deepEqual(logs[1].meta, { reconnect: true });
});
