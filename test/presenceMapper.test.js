const assert = require("node:assert/strict");
const test = require("node:test");
const { PresenceMapper, extractSignalPath } = require("../src/presenceMapper");

test("local valid length includes end timestamp", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });
  const activity = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 300,
      seek_position: 42,
      three_line: {
        line1: "Track",
        line2: "Artist",
        line3: "Album"
      }
    }
  });

  assert.equal(activity.details, "Track");
  assert.equal(activity.state, "Artist");
  assert.deepEqual(activity.timestamps, { start: 1958000, end: 2258000 });
});

test("radio invalid length omits end timestamp", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });
  const activity = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      three_line: {
        line1: "DI.FM - Vocal Trance",
        line2: "Live stream",
        line3: "DI.FM"
      }
    }
  });

  assert.equal(activity.details, "DI.FM - Vocal Trance");
  assert.equal(activity.state, "Live stream");
  assert.deepEqual(activity.timestamps, { start: 2000000 });
  assert.equal("end" in activity.timestamps, false);
});

test("DI.FM with finite Roon length is still treated as radio", () => {
  const mapper = new PresenceMapper({ clock: () => 1_780_447_314_406 });
  const presence = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    is_seek_allowed: false,
    seek_position: 0,
    now_playing: {
      length: 240,
      seek_position: 0,
      two_line: {
        line1: "01 Progressive House -DI.FM",
        line2: "Abyss"
      },
      three_line: {
        line1: "01 Progressive House -DI.FM",
        line2: "Abyss",
        line3: ""
      }
    }
  });

  assert.equal(presence.timestampMode, "RADIO");
  assert.equal(presence.activity.details, "01 Progressive House -DI.FM");
  assert.equal(presence.activity.state, "Abyss");
  assert.deepEqual(presence.activity.timestamps, { start: 1780447314406 });
  assert.equal("end" in presence.activity.timestamps, false);
});

test("radio uses Roon stream seek_position for elapsed listening time", () => {
  const mapper = new PresenceMapper({ clock: () => 5_000_000 });
  const presence = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    is_seek_allowed: false,
    seek_position: 4629,
    now_playing: {
      length: 240,
      seek_position: 4629,
      three_line: {
        line1: "Progressive House -DI.FM",
        line2: "Johan N. Lecander - DI.FM's Top 10",
        line3: "DI.FM"
      }
    }
  });

  assert.equal(presence.timestampMode, "RADIO");
  assert.deepEqual(presence.activity.timestamps, { start: 371000 });
});

test("radio fallback timer does not reset when stream metadata changes", () => {
  let now = 5_000_000;
  const mapper = new PresenceMapper({ clock: () => now });

  const first = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    is_seek_allowed: false,
    now_playing: {
      three_line: {
        line1: "Progressive House -DI.FM",
        line2: "Artist A",
        line3: "DI.FM"
      }
    }
  });
  now += 60_000;
  const second = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    is_seek_allowed: false,
    now_playing: {
      three_line: {
        line1: "Progressive House -DI.FM",
        line2: "Artist B",
        line3: "DI.FM"
      }
    }
  });

  assert.deepEqual(first.activity.timestamps, { start: 5000000 });
  assert.deepEqual(second.activity.timestamps, { start: 5000000 });
});

test("local long duration uses millisecond progress timestamps", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });
  const activity = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 3723,
      seek_position: 3,
      three_line: {
        line1: "Long Track",
        line2: "Artist",
        line3: "Album"
      }
    }
  });

  assert.equal(activity.state, "Artist");
  assert.deepEqual(activity.timestamps, { start: 1997000, end: 5720000 });
});

test("HQPlayer signal path is shown as bottom Discord line when available", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });
  const presence = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    signal_path: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
    now_playing: {
      length: 120,
      seek_position: 8,
      three_line: {
        line1: "In The Silence",
        line2: "AstroPilot / Unusual Cosmic Proc...",
        line3: "Album"
      }
    }
  });

  assert.equal(presence.activity.details, "In The Silence - AstroPilot / Unusual Cosmic Proc...");
  assert.equal(presence.activity.state, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
  assert.equal(presence.metadata.signalPath, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
});

test("HQPlayer signal path can be extracted from nested output fields", () => {
  const signalPath = extractSignalPath(
    {
      outputs: [
        {
          signalPath: [
            { name: "poly-sinc-gauss-hires-mp" },
            { name: "TPDF" },
            { name: "PCM" },
            { name: "768kHz" }
          ]
        }
      ]
    },
    {}
  );

  assert.equal(signalPath, "poly-sinc-gauss-hires-mp > TPDF > PCM > 768kHz");
});

test("album art metadata is extracted from Roon now_playing", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });
  const presence = mapper.mapPresence({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 120,
      seek_position: 8,
      image_key: "abc123",
      album_art_url: "http://127.0.0.1:9100/api/image/abc123?scale=fill",
      three_line: {
        line1: "Track",
        line2: "Artist",
        line3: "Album"
      }
    }
  });

  assert.equal(presence.metadata.albumArtKey, "abc123");
  assert.equal(presence.metadata.albumArtUrl, "http://127.0.0.1:9100/api/image/abc123?scale=fill");
});

test("switching between local and radio keeps timestamp safety", () => {
  const mapper = new PresenceMapper({ clock: () => 2_000_000 });

  const local = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 180,
      seek_position: 10,
      three_line: { line1: "Local", line2: "Artist" }
    }
  });

  const radio = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      three_line: { line1: "DI.FM", line2: "Radio" }
    }
  });

  const localAgain = mapper.mapZone({
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 180,
      seek_position: 20,
      three_line: { line1: "Local Again", line2: "Artist" }
    }
  });

  assert.equal("end" in local.timestamps, true);
  assert.equal("end" in radio.timestamps, false);
  assert.equal("end" in localAgain.timestamps, true);
});
