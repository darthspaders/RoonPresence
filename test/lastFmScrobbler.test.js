const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  LastFmScrobbler,
  createApiSignature,
  hasFullRadioTrack,
  readDurationMs
} = require("../src/lastFmScrobbler");

function radioPresence({
  artist = "E-Clip",
  title = "Indian Spirit",
  key = "e-clip|indian spirit",
  durationMs = 240_000
} = {}) {
  const metadata = {
    artist,
    title,
    album: "Progressive Psy - DI.FM",
    radioTrackKey: key
  };
  if (durationMs !== undefined) metadata.trackDurationMs = durationMs;

  return {
    timestampMode: "RADIO",
    activity: {
      timestamps: { start: 1_780_000_000_000 }
    },
    metadata
  };
}

function createScrobbler({ nowRef, requests, logger = undefined, scrobbleCachePath = "", scrobbleCooldownMs = undefined } = {}) {
  return new LastFmScrobbler({
    enabled: true,
    apiKey: "api-key",
    apiSecret: "secret",
    sessionKey: "session",
    logger,
    scrobbleCachePath,
    scrobbleCooldownMs,
    clock: () => nowRef.value,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: Object.fromEntries(options.body.entries()) });
      return {
        ok: true,
        json: async () => ({ scrobbles: { "@attr": { accepted: "1", ignored: "0" } } })
      };
    }
  });
}

test("Last.fm signature sorts params and appends secret", () => {
  assert.equal(
    createApiSignature({ method: "track.scrobble", track: "Song", artist: "Artist" }, "secret"),
    createApiSignature({ artist: "Artist", track: "Song", method: "track.scrobble" }, "secret")
  );
});

test("radio scrobbling requires artist and title", () => {
  assert.equal(hasFullRadioTrack(radioPresence()), true);
  assert.equal(hasFullRadioTrack(radioPresence({ artist: "", key: "|title" })), false);
  assert.equal(hasFullRadioTrack({ ...radioPresence(), timestampMode: "LOCAL" }), false);
});

test("duration reader accepts milliseconds and seconds", () => {
  assert.equal(readDurationMs(radioPresence({ durationMs: 240_000 })), 240_000);
  assert.equal(readDurationMs({ metadata: { trackDurationSeconds: 240 } }), 240_000);
  assert.equal(readDurationMs({ metadata: {} }), null);
});

test("scrobbler posts a parsed radio track immediately once", async () => {
  const requests = [];
  const nowRef = { value: 1_780_000_123_000 };
  const scrobbler = createScrobbler({ nowRef, requests });

  assert.equal(scrobbler.maybeScrobble(radioPresence({ durationMs: null })), true);
  assert.equal(scrobbler.maybeScrobble(radioPresence({ durationMs: null })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.method, "track.scrobble");
  assert.equal(requests[0].body.artist, "E-Clip");
  assert.equal(requests[0].body.track, "Indian Spirit");
  assert.equal(requests[0].body.timestamp, "1780000123");
  assert.equal(requests[0].body.chosenByUser, "0");
  assert.ok(requests[0].body.api_sig);
});

test("scrobbler posts a new radio track immediately on track change", async () => {
  const requests = [];
  const nowRef = { value: 1_780_000_000_000 };
  const scrobbler = createScrobbler({ nowRef, requests });

  assert.equal(scrobbler.maybeScrobble(radioPresence({ durationMs: null })), true);
  nowRef.value += 30_000;
  assert.equal(scrobbler.maybeScrobble(radioPresence({
    artist: "Sunflare",
    title: "Lotus",
    key: "sunflare|lotus",
    durationMs: null
  })), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.artist, "E-Clip");
  assert.equal(requests[0].body.track, "Indian Spirit");
  assert.equal(requests[1].body.artist, "Sunflare");
  assert.equal(requests[1].body.track, "Lotus");
});

test("scrobbler ignores title-only radio mixes", () => {
  const scrobbler = new LastFmScrobbler({
    enabled: true,
    apiKey: "api-key",
    apiSecret: "secret",
    sessionKey: "session",
    fetchImpl: async () => {
      throw new Error("should not post");
    }
  });

  assert.equal(scrobbler.maybeScrobble(radioPresence({ artist: "", title: "DI.FM Top 10", key: "|di.fm top 10" })), false);
});


test("scrobbler skips same radio track after app restart within cooldown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-lastfm-"));
  const cachePath = path.join(dir, "lastfm-cache.json");
  const requests = [];
  const nowRef = { value: 1_780_000_000_000 };

  const firstRun = createScrobbler({ nowRef, requests, scrobbleCachePath: cachePath });
  assert.equal(firstRun.maybeScrobble(radioPresence({ durationMs: null })), true);
  await new Promise((resolve) => setImmediate(resolve));

  nowRef.value += 60_000;
  const restartedRun = createScrobbler({ nowRef, requests, scrobbleCachePath: cachePath });
  assert.equal(restartedRun.maybeScrobble(radioPresence({ durationMs: null })), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
});

test("scrobbler allows same radio track again after cooldown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-lastfm-"));
  const cachePath = path.join(dir, "lastfm-cache.json");
  const requests = [];
  const nowRef = { value: 1_780_000_000_000 };

  const firstRun = createScrobbler({ nowRef, requests, scrobbleCachePath: cachePath });
  assert.equal(firstRun.maybeScrobble(radioPresence({ durationMs: null })), true);
  await new Promise((resolve) => setImmediate(resolve));

  nowRef.value += 15 * 60 * 1000 + 1;
  const restartedRun = createScrobbler({ nowRef, requests, scrobbleCachePath: cachePath });
  assert.equal(restartedRun.maybeScrobble(radioPresence({ durationMs: null })), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 2);
});

test("scrobbler reports Last.fm JSON errors", async () => {
  const scrobbler = new LastFmScrobbler({
    enabled: true,
    apiKey: "api-key",
    apiSecret: "secret",
    sessionKey: "session",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 9, message: "Invalid session key" })
    })
  });

  await assert.rejects(
    () => scrobbler.scrobble({ artist: "Sunflare", title: "Lotus" }, 1780000123),
    /9: Invalid session key/
  );
});
