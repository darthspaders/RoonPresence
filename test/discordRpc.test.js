const assert = require("node:assert/strict");
const test = require("node:test");
const { DiscordRpcClient } = require("../src/discordRpc");

test("discord adapter preserves listening type and converts timestamp fields", () => {
  const client = new DiscordRpcClient({
    clientId: "123",
    logger: {
      info() {},
      warn() {}
    }
  });

  const wireActivity = client.toRpcWireActivity({
    type: 2,
    details: "Track",
    state: "Artist",
    instance: false,
    startTimestamp: 1780446335242,
    endTimestamp: 1780446508242
  });

  assert.deepEqual(wireActivity, {
    type: 2,
    details: "Track",
    state: "Artist",
    instance: false,
    timestamps: {
      start: 1780446335242,
      end: 1780446508242
    }
  });
});

test("discord adapter clears activity when switching from ended track to open-ended stream", async () => {
  const calls = [];
  const client = new DiscordRpcClient({
    clientId: "123",
    logger: {
      info() {},
      warn() {}
    }
  });
  client.ready = true;
  client.client = {
    request: async (command, payload) => {
      calls.push({ command, payload });
    },
    clearActivity: async () => {
      calls.push({ command: "CLEAR_ACTIVITY" });
    }
  };

  await client.setActivity({
    type: 2,
    details: "Track",
    state: "Artist",
    instance: false,
    startTimestamp: 1780446335242,
    endTimestamp: 1780446508242
  });

  await client.setActivity({
    type: 2,
    details: "DI.FM",
    state: "Radio",
    instance: false,
    startTimestamp: 1780446510000
  });

  assert.deepEqual(
    calls.map((call) => call.command),
    ["SET_ACTIVITY", "CLEAR_ACTIVITY", "SET_ACTIVITY"]
  );
  assert.deepEqual(calls[2].payload.activity.timestamps, {
    start: 1780446510000
  });
});

test("discord adapter clears before every open-ended stream publish", async () => {
  const calls = [];
  const client = new DiscordRpcClient({
    clientId: "123",
    logger: {
      info() {},
      warn() {}
    }
  });
  client.ready = true;
  client.client = {
    request: async (command, payload) => {
      calls.push({ command, payload });
    },
    clearActivity: async () => {
      calls.push({ command: "CLEAR_ACTIVITY" });
    }
  };

  await client.setActivity({
    type: 2,
    details: "DI.FM",
    state: "Radio",
    instance: false,
    startTimestamp: 1780446510000
  });

  assert.deepEqual(
    calls.map((call) => call.command),
    ["CLEAR_ACTIVITY", "SET_ACTIVITY"]
  );
  assert.deepEqual(calls[1].payload.activity.timestamps, {
    start: 1780446510000
  });
});

test("discord adapter open-ended wire activity does not contain end timestamp", () => {
  const client = new DiscordRpcClient({
    clientId: "123",
    logger: {
      info() {},
      warn() {}
    }
  });

  const wireActivity = client.toRpcWireActivity({
    type: 2,
    details: "DI.FM",
    state: "Radio",
    instance: false,
    startTimestamp: 1780446510000
  });

  assert.deepEqual(wireActivity, {
    type: 2,
    details: "DI.FM",
    state: "Radio",
    instance: false,
    timestamps: {
      start: 1780446510000
    }
  });
});

test("discord adapter maps large image fields to RPC assets", () => {
  const client = new DiscordRpcClient({
    clientId: "123",
    logger: {
      info() {},
      warn() {}
    }
  });

  const wireActivity = client.toRpcWireActivity({
    type: 2,
    details: "Track",
    state: "Artist",
    instance: false,
    largeImageKey: "http://127.0.0.1:9100/api/image/abc123",
    largeImageText: "Track - Artist"
  });

  assert.deepEqual(wireActivity.assets, {
    large_image: "http://127.0.0.1:9100/api/image/abc123",
    large_text: "Track - Artist"
  });
});
