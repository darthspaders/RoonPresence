const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RoonClient,
  getRoonImageEndpoint,
  isPrivateImageUrl,
  zoneContentSignature
} = require("../src/roonClient");

function createLogger() {
  const logs = {
    info: [],
    warn: [],
    error: [],
    debug: []
  };
  const logger = Object.fromEntries(
    Object.keys(logs).map((level) => [
      level,
      (message, meta) => logs[level].push({ message, meta })
    ])
  );

  return { logger, logs };
}

function createClient(options = {}) {
  let now = 2_000_000;
  const { logger, logs } = createLogger();
  const client = new RoonClient({
    roonConfig: {},
    hqplayerZoneMatch: "HQPlayer",
    fallbackZoneMatch: "System Output",
    logger,
    clock: () => now,
    ...options
  });

  return {
    client,
    logs,
    advance(ms) {
      now += ms;
    }
  };
}

function playingZone({
  zoneId = "zone-1",
  displayName = "HQPlayer",
  outputName = "",
  sourceControls = [],
  seek = 0,
  title = "Track",
  imageKey = ""
} = {}) {
  return {
    zone_id: zoneId,
    display_name: displayName,
    state: "playing",
    outputs: outputName
      ? [
          {
            display_name: outputName,
            source_controls: sourceControls
          }
        ]
      : [],
    now_playing: {
      length: 300,
      seek_position: seek,
      image_key: imageKey,
      three_line: {
        line1: title,
        line2: "Artist",
        line3: "Album"
      }
    }
  };
}

test("zone content signature ignores progress-only seek changes", () => {
  assert.equal(zoneContentSignature(playingZone({ seek: 1 })), zoneContentSignature(playingZone({ seek: 2 })));
});

test("Roon client suppresses normal progress ticks but emits real seek jumps", () => {
  const { client, advance } = createClient();

  assert.equal(client.shouldEmitPlaying(playingZone({ seek: 10 })), true);
  advance(1_000);
  assert.equal(client.shouldEmitPlaying(playingZone({ seek: 11 })), false);
  advance(1_000);
  assert.equal(client.shouldEmitPlaying(playingZone({ seek: 12 })), false);
  advance(1_000);
  assert.equal(client.shouldEmitPlaying(playingZone({ seek: 80 })), true);
});

test("Roon client emits new tracks immediately", () => {
  const { client, advance } = createClient();

  assert.equal(client.shouldEmitPlaying(playingZone({ title: "Track A", seek: 1 })), true);
  advance(1_000);
  assert.equal(client.shouldEmitPlaying(playingZone({ title: "Track B", seek: 2 })), true);
});

test("Roon client builds album art URL from image key", () => {
  const { client } = createClient();
  const zone = playingZone();
  zone.now_playing.image_key = "image/key 1";
  client.core = {
    moo: {
      transport: {
        host: "127.0.0.1",
        port: 9100
      }
    }
  };

  client.applyAlbumArtUrl(zone);

  assert.equal(
    zone.now_playing.album_art_url,
    "http://127.0.0.1:9100/api/image/image%2Fkey%201?width=512&height=512"
  );
});

test("Roon client builds album art URL from registration HTTP port fallback", () => {
  const { client } = createClient();
  const zone = playingZone({ imageKey: "fallback/key" });
  client.core = {
    registration: {
      http_port: 9200
    }
  };

  client.applyAlbumArtUrl(zone);

  assert.deepEqual(getRoonImageEndpoint(client.core), { host: "127.0.0.1", port: 9200 });
  assert.equal(
    zone.now_playing.album_art_url,
    "http://127.0.0.1:9200/api/image/fallback%2Fkey?width=512&height=512"
  );
});

test("Roon client falls back to System Output when no HQPlayer zone is playing", () => {
  const { client, logs } = createClient();
  const zone = playingZone({
    zoneId: "system-output",
    displayName: "System Output",
    outputName: "System Output",
    title: "System Track",
    imageKey: "system/key"
  });
  client.core = {
    moo: {
      transport: {
        host: "127.0.0.1",
        port: 9100
      }
    }
  };

  let emitted = null;
  client.on("playing", (selected) => {
    emitted = selected;
  });
  client.zones.set(zone.zone_id, zone);

  client.evaluateActiveZone("zones_changed");

  assert.equal(client.activeZoneId, "system-output");
  assert.equal(emitted?.zone_id, "system-output");
  assert.equal(
    emitted?.now_playing?.album_art_url,
    "http://127.0.0.1:9100/api/image/system%2Fkey?width=512&height=512"
  );
  assert.match(logs.info.map((entry) => entry.message).join("\n"), /Using fallback Roon zone: System Output/);
});

test("Roon client prefers a playing HQPlayer zone over System Output fallback", () => {
  const { client } = createClient();
  const systemZone = playingZone({
    zoneId: "system-output",
    displayName: "System Output",
    outputName: "System Output",
    title: "System Track"
  });
  const hqplayerZone = playingZone({
    zoneId: "hqplayer",
    displayName: "HQPlayer",
    title: "HQPlayer Track"
  });

  let emitted = null;
  client.on("playing", (selected) => {
    emitted = selected;
  });
  client.zones.set(systemZone.zone_id, systemZone);
  client.zones.set(hqplayerZone.zone_id, hqplayerZone);

  client.evaluateActiveZone("zones_changed");

  assert.equal(client.activeZoneId, "hqplayer");
  assert.equal(emitted?.zone_id, "hqplayer");
});

test("Roon client matches HQPlayer from any output source control", () => {
  const { client } = createClient();
  const zone = playingZone({
    zoneId: "source-zone",
    displayName: "Main Room",
    outputName: "Main Room",
    sourceControls: [
      { display_name: "Chromecast" },
      { display_name: "HQPlayer" }
    ],
    title: "Source Control Track"
  });

  let emitted = null;
  client.on("playing", (selected) => {
    emitted = selected;
  });
  client.zones.set(zone.zone_id, zone);

  client.evaluateActiveZone("zones_changed");

  assert.equal(client.activeZoneId, "source-zone");
  assert.equal(emitted?.zone_id, "source-zone");
});

test("Roon client detects private album art URLs", () => {
  assert.equal(isPrivateImageUrl("http://127.0.0.1:9100/api/image/key"), true);
  assert.equal(isPrivateImageUrl("http://192.168.1.22:9100/api/image/key"), true);
  assert.equal(isPrivateImageUrl("https://example.com/image.jpg"), false);
});
