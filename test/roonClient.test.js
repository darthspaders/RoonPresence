const assert = require("node:assert/strict");
const test = require("node:test");
const { RoonClient, isPrivateImageUrl, zoneContentSignature } = require("../src/roonClient");

function createClient() {
  let now = 2_000_000;
  const client = new RoonClient({
    roonConfig: {},
    hqplayerZoneMatch: "HQPlayer",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    clock: () => now
  });

  return {
    client,
    advance(ms) {
      now += ms;
    }
  };
}

function playingZone({ seek = 0, title = "Track" } = {}) {
  return {
    zone_id: "zone-1",
    display_name: "HQPlayer",
    state: "playing",
    now_playing: {
      length: 300,
      seek_position: seek,
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
    "http://127.0.0.1:9100/api/image/image%2Fkey%201?scale=fill&width=512&height=512&format=image/jpeg"
  );
});

test("Roon client detects private album art URLs", () => {
  assert.equal(isPrivateImageUrl("http://127.0.0.1:9100/api/image/key"), true);
  assert.equal(isPrivateImageUrl("http://192.168.1.22:9100/api/image/key"), true);
  assert.equal(isPrivateImageUrl("https://example.com/image.jpg"), false);
});
