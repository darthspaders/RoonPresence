const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LastFmScrobbler,
  createApiSignature,
  hasFullRadioTrack
} = require("../src/lastFmScrobbler");

function radioPresence({ artist = "E-Clip", title = "Indian Spirit", key = "e-clip|indian spirit" } = {}) {
  return {
    timestampMode: "RADIO",
    activity: {
      timestamps: { start: 1_780_000_000_000 }
    },
    metadata: {
      artist,
      title,
      album: "Progressive Psy - DI.FM",
      radioTrackKey: key
    }
  };
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

test("scrobbler posts one parsed radio track once", async () => {
  const requests = [];
  const scrobbler = new LastFmScrobbler({
    enabled: true,
    apiKey: "api-key",
    apiSecret: "secret",
    sessionKey: "session",
    clock: () => 1_780_000_123_000,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: Object.fromEntries(options.body.entries()) });
      return {
        ok: true,
        json: async () => ({ scrobbles: { "@attr": { accepted: "1", ignored: "0" } } })
      };
    }
  });

  assert.equal(scrobbler.maybeScrobble(radioPresence()), true);
  assert.equal(scrobbler.maybeScrobble(radioPresence()), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.method, "track.scrobble");
  assert.equal(requests[0].body.artist, "E-Clip");
  assert.equal(requests[0].body.track, "Indian Spirit");
  assert.equal(requests[0].body.timestamp, "1780000123");
  assert.equal(requests[0].body.chosenByUser, "0");
  assert.ok(requests[0].body.api_sig);
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

