const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RadioMetadataResolver,
  chooseCoverImage,
  getRadioStationName,
  makeLookupKey,
  parseRadioTrack
} = require("../src/radioMetadataResolver");

test("parses radio artist and title from separate metadata fields", () => {
  assert.deepEqual(
    parseRadioTrack({ title: "Whisper", artist: "Boombox Cartel", album: "DI.FM" }),
    { title: "Whisper", artist: "Boombox Cartel" }
  );
});

test("parses artist-title radio text", () => {
  assert.deepEqual(
    parseRadioTrack({ title: "747 - While My 303 Gently Weeps", artist: "DI.FM" }),
    { artist: "747", title: "While My 303 Gently Weeps" }
  );
});

test("ignores station-only radio metadata", () => {
  assert.equal(parseRadioTrack({ title: "Progressive House -DI.FM", artist: "DI.FM" }), null);
});

test("parses DI.FM station title with artist-title subtitle", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "04 Progressive Psy - DI.FM Premium",
      artist: "E-Clip - Indian Spirit",
      album: "DI.FM"
    }),
    { artist: "E-Clip", title: "Indian Spirit" }
  );
});

test("fills missing artist from separate field when title has station prefix", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "04 Progressive Psy - Indian Spirit",
      artist: "E-Clip",
      album: "DI.FM"
    }),
    { artist: "E-Clip", title: "Indian Spirit" }
  );
});

test("parses station title plus plain subtitle as title-only track", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "Progressive House -DI.FM",
      artist: "Apollo (Fuenka Remix)",
      album: "DI.FM"
    }),
    { artist: "", title: "Apollo (Fuenka Remix)" }
  );
});

test("extracts radio station display name", () => {
  assert.equal(
    getRadioStationName({
      title: "04 Progressive Psy - DI.FM Premium",
      artist: "E-Clip - Indian Spirit",
      album: "DI.FM"
    }),
    "04 Progressive Psy - DI.FM Premium"
  );
});

test("chooses front cover image thumbnail", () => {
  assert.equal(
    chooseCoverImage({
      images: [
        {
          front: true,
          thumbnails: {
            "500": "https://archive.org/cover-500.jpg",
            small: "https://archive.org/cover-small.jpg"
          },
          image: "https://archive.org/full.jpg"
        }
      ]
    }),
    "https://archive.org/cover-500.jpg"
  );
});

test("resolver looks up MusicBrainz and Cover Art Archive metadata", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("musicbrainz.org")) {
        return {
          recordings: [
            {
              title: "Whisper",
              releases: [
                {
                  id: "release-1",
                  title: "Album Name",
                  "release-group": { id: "group-1" }
                }
              ]
            }
          ]
        };
      }
      return {
        images: [
          {
            front: true,
            thumbnails: { "500": "https://archive.org/whisper.jpg" }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "Boombox Cartel", title: "Whisper" },
    "boombox cartel|whisper"
  );

  assert.equal(result.album, "Album Name");
  assert.equal(result.albumArtUrl, "https://archive.org/whisper.jpg");
  assert.equal(requested.length, 2);
  assert.match(requested[0], /^https:\/\/musicbrainz\.org\/ws\/2\/recording/);
  assert.equal(requested[1], "https://coverartarchive.org/release-group/group-1");
});

test("resolver applies cached radio artwork to radio presence", () => {
  const resolver = new RadioMetadataResolver({ enabled: true });
  const key = makeLookupKey({ artist: "Boombox Cartel", title: "Whisper" });
  resolver.remember(key, {
    status: "found",
    value: {
      key,
      album: "Album Name",
      albumArtUrl: "https://archive.org/whisper.jpg"
    }
  });

  const presence = {
    timestampMode: "RADIO",
    metadata: {
      title: "Whisper",
      artist: "Boombox Cartel",
      album: "DI.FM",
      albumArtUrl: "http://127.0.0.1/station.jpg",
      albumArtKey: "station"
    }
  };

  assert.equal(resolver.apply(presence), true);
  assert.equal(presence.metadata.album, "Album Name");
  assert.equal(presence.metadata.albumArtUrl, "https://archive.org/whisper.jpg");
  assert.equal(presence.metadata.albumArtKey, `radio:${key}`);
  assert.equal(presence.metadata.radioTrackKey, key);
  assert.equal(presence.metadata.radioArtworkResolved, true);
});

test("resolver marks pending radio artwork as unresolved for the current track", () => {
  const resolver = new RadioMetadataResolver({ enabled: true, minLookupIntervalMs: 60_000 });
  const presence = {
    timestampMode: "RADIO",
    metadata: {
      title: "Insomniac|MPACT - Sully - Eraser",
      artist: "Insomniac Radio",
      album: "Insomniac|MPACT",
      albumArtUrl: "https://archive.org/old.jpg",
      albumArtKey: "radio:old|track"
    }
  };

  assert.equal(resolver.apply(presence), false);
  assert.equal(presence.metadata.radioTrackKey, "sully|eraser");
  assert.equal(presence.metadata.radioArtworkResolved, false);
  assert.equal(presence.metadata.radioStationName, "Insomniac|MPACT");
  assert.equal(resolver.queue.length, 1);
  resolver.stop();
});

test("resolver clears artist for title-only radio tracks", () => {
  const resolver = new RadioMetadataResolver({ enabled: true, minLookupIntervalMs: 60_000 });
  const presence = {
    timestampMode: "RADIO",
    activity: {
      details: "Progressive House -DI.FM",
      state: "Apollo (Fuenka Remix)"
    },
    metadata: {
      title: "Progressive House -DI.FM",
      artist: "Apollo (Fuenka Remix)",
      album: "DI.FM"
    }
  };

  assert.equal(resolver.apply(presence), false);
  assert.equal(presence.metadata.title, "Apollo (Fuenka Remix)");
  assert.equal(presence.metadata.artist, "");
  assert.equal(presence.activity.details, "Apollo (Fuenka Remix)");
  assert.equal(presence.activity.state, "Progressive House -DI.FM");
  resolver.stop();
});

test("resolver applies parsed radio track text before artwork resolves", () => {
  const resolver = new RadioMetadataResolver({ enabled: true, minLookupIntervalMs: 60_000 });
  const presence = {
    timestampMode: "RADIO",
    activity: {
      details: "04 Progressive Psy - DI.FM Premium",
      state: "E-Clip - Indian Spirit"
    },
    metadata: {
      title: "04 Progressive Psy - DI.FM Premium",
      artist: "E-Clip - Indian Spirit",
      album: "DI.FM"
    }
  };

  assert.equal(resolver.apply(presence), false);
  assert.equal(presence.metadata.title, "Indian Spirit");
  assert.equal(presence.metadata.artist, "E-Clip");
  assert.equal(presence.activity.details, "Indian Spirit");
  assert.equal(presence.activity.state, "E-Clip");
  resolver.stop();
});

test("resolver does not run for local tracks", () => {
  const resolver = new RadioMetadataResolver({ enabled: true });
  const presence = {
    timestampMode: "LOCAL",
    metadata: {
      title: "Whisper",
      artist: "Boombox Cartel"
    }
  };

  assert.equal(resolver.apply(presence), false);
  assert.equal(resolver.queue.length, 0);
});
test("parses station-prefixed title as title-only lookup", () => {
  assert.deepEqual(
    parseRadioTrack({ title: "Insomniac|MPACT - Veil Remover", artist: "Insomniac Radio" }),
    { artist: "", title: "Veil Remover" }
  );
});

test("resolver falls back to title-only MusicBrainz lookup", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("musicbrainz.org")) {
        return {
          recordings: [
            {
              title: "Veil Remover",
              releases: [
                {
                  id: "release-2",
                  title: "Veil Remover",
                  "release-group": { id: "group-2" }
                }
              ]
            }
          ]
        };
      }
      return {
        images: [
          {
            front: true,
            thumbnails: { "500": "https://archive.org/veil-remover.jpg" }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "", title: "Veil Remover" },
    "|veil remover"
  );

  assert.equal(result.albumArtUrl, "https://archive.org/veil-remover.jpg");
  assert.match(decodeURIComponent(requested[0]), /recording:"Veil Remover"/);
  assert.doesNotMatch(decodeURIComponent(requested[0]), /artist:/);
});
test("parses station-prefixed artist-title metadata", () => {
  assert.deepEqual(
    parseRadioTrack({ title: "Insomniac|MPACT - Sully - Eraser", artist: "Insomniac Radio" }),
    { artist: "Sully", title: "Eraser" }
  );
});
