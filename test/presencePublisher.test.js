const assert = require("node:assert/strict");
const test = require("node:test");
const { PresenceMapper } = require("../src/presenceMapper");
const { PresencePublisher } = require("../src/presencePublisher");

function createHarness() {
  let now = 2_000_000;
  const published = [];
  const logs = [];
  const mapper = new PresenceMapper({ clock: () => now });
  const publisher = new PresencePublisher({
    mapper,
    clock: () => now,
    minPublishIntervalMs: 10_000,
    discord: {
      setActivity: (activity) => published.push(activity),
      clearActivity: () => published.push(null)
    },
    logger: {
      info: (message) => logs.push(message)
    }
  });

  return {
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    published,
    logs,
    publisher
  };
}

function createHarnessWithSignalPath(signalPath) {
  let now = 2_000_000;
  const published = [];
  const logs = [];
  const mapper = new PresenceMapper({ clock: () => now });
  const publisher = new PresencePublisher({
    mapper,
    clock: () => now,
    minPublishIntervalMs: 10_000,
    signalPathProvider: {
      getSignalPath: () => signalPath
    },
    discord: {
      setActivity: (activity) => published.push(activity),
      clearActivity: () => published.push(null)
    },
    logger: {
      info: (message) => logs.push(message)
    }
  });

  return { published, logs, publisher };
}

function createMutableSignalHarness(signalPath) {
  let currentSignalPath = signalPath;
  const harness = createHarnessWithSignalPath("");
  harness.publisher.signalPathProvider = {
    getSignalPath: () => currentSignalPath
  };
  harness.setSignalPath = (nextSignalPath) => {
    currentSignalPath = nextSignalPath;
  };
  return harness;
}

function localZone({ title = "Track", artist = "Artist", album = "Album", seek = 0 } = {}) {
  return {
    zone_id: "zone-1",
    display_name: "HQPlayer",
    now_playing: {
      length: 300,
      seek_position: seek,
      three_line: {
        line1: title,
        line2: artist,
        line3: album
      }
    }
  };
}

function localZoneWithSignalPath({ signalPath }) {
  return {
    ...localZone(),
    signal_path: signalPath
  };
}

function localZoneWithAlbumArt() {
  return {
    ...localZone(),
    now_playing: {
      ...localZone().now_playing,
      image_key: "abc123",
      album_art_url: "http://127.0.0.1:9100/api/image/abc123?scale=fill"
    }
  };
}

function radioZone({ title = "DI.FM", artist = "Radio", seek } = {}) {
  return {
    zone_id: "zone-1",
    display_name: "HQPlayer",
    is_seek_allowed: false,
    seek_position: seek,
    now_playing: {
      length: 240,
      seek_position: seek,
      three_line: {
        line1: title,
        line2: artist,
        line3: "DI.FM"
      }
    }
  };
}

test("same track with changing seek_position does not republish repeatedly", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZone({ seek: 10 })), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 11 })), false);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 12 })), false);

  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].type, 2);
  assert.ok(harness.logs.includes("Presence unchanged; skipping publish"));
});

test("new track publishes immediately", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZone({ title: "Track A" })), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone({ title: "Track B" })), true);

  assert.equal(harness.published.length, 2);
  assert.equal(harness.published[1].details, "Track B");
});

test("local to radio publishes once and removes end timestamp", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZone()), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(radioZone()), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(radioZone({ seek: 1 })), false);

  assert.equal(harness.published.length, 2);
  assert.equal(harness.published[0].type, 2);
  assert.equal(harness.published[1].type, 2);
  assert.equal("endTimestamp" in harness.published[0], true);
  assert.equal("endTimestamp" in harness.published[1], false);
});

test("radio to local restores progress bar end timestamp", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(radioZone()), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone()), true);

  assert.equal(harness.published.length, 2);
  assert.equal("startTimestamp" in harness.published[0], true);
  assert.equal("startTimestamp" in harness.published[1], true);
  assert.equal("endTimestamp" in harness.published[0], false);
  assert.equal("endTimestamp" in harness.published[1], true);
});

test("local track progress bar data is stable across seek-only updates", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZone({ seek: 10 })), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 11 })), false);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 12 })), false);

  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].startTimestamp, 1990000);
  assert.equal(harness.published[0].endTimestamp, 2290000);
});

test("local track does not republish after throttle interval for tiny timestamp drift", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZone({ seek: 10 })), true);
  harness.now += 10_202;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 20 })), false);
  harness.now += 10_829;
  assert.equal(harness.publisher.publishZone(localZone({ seek: 31 })), false);

  assert.equal(harness.published.length, 1);
});

test("radio seek/progress update does not republish repeatedly", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(radioZone({ seek: 4629 })), true);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(radioZone({ seek: 4630 })), false);
  harness.now += 1_000;
  assert.equal(harness.publisher.publishZone(radioZone({ seek: 4631 })), false);

  assert.equal(harness.published.length, 1);
});

test("radio activity never includes endTimestamp even if upstream timestamps contain end", () => {
  const harness = createHarness();
  const activity = harness.publisher.toDiscordRpcActivity({
    timestampMode: "RADIO",
    activity: {
      details: "DI.FM",
      state: "Radio",
      instance: false,
      timestamps: {
        start: 1780446510000,
        end: 1780447000000
      }
    }
  });

  assert.deepEqual(activity, {
    type: 2,
    details: "DI.FM",
    state: "Radio",
    instance: false,
    startTimestamp: 1780446510000
  });
});

test("signal path changes republish presence", () => {
  const harness = createHarness();

  assert.equal(
    harness.publisher.publishZone(
      localZoneWithSignalPath({ signalPath: "poly-sinc-gauss-hires-mp, PCM, 768kHz" })
    ),
    true
  );
  harness.now += 1_000;
  assert.equal(
    harness.publisher.publishZone(
      localZoneWithSignalPath({ signalPath: "poly-sinc-gauss-hires-mp, DSD256" })
    ),
    true
  );

  assert.equal(harness.published.length, 2);
  assert.equal(harness.published[0].state, "poly-sinc-gauss-hires-mp, PCM, 768kHz");
  assert.equal(harness.published[1].state, "poly-sinc-gauss-hires-mp, DSD256");
});

test("external HQPlayer signal path overrides Roon metadata bottom line", () => {
  const harness = createHarnessWithSignalPath("poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");

  assert.equal(harness.publisher.publishZone(localZone()), true);

  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].details, "Track - Artist");
  assert.equal(harness.published[0].state, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
});

test("private Roon album art is not sent directly to Discord", () => {
  const harness = createHarness();

  assert.equal(harness.publisher.publishZone(localZoneWithAlbumArt()), true);

  assert.equal("largeImageKey" in harness.published[0], false);
  assert.ok(
    harness.logs.includes(
      "Album art found, but not sent to Discord. Set ALBUM_ART_PUBLIC_BASE_URL to a public HTTPS URL for this CLI."
    )
  );
});

test("album art proxy URL is sent as Discord large image", () => {
  const harness = createHarness();
  harness.publisher.albumArtProvider = {
    getPublicUrl: (sourceUrl, imageKey) => {
      assert.equal(sourceUrl, "http://127.0.0.1:9100/api/image/abc123?scale=fill");
      assert.equal(imageKey, "abc123");
      return "https://roon-art.example.com/art/abc123.jpg";
    }
  };

  assert.equal(harness.publisher.publishZone(localZoneWithAlbumArt()), true);

  assert.equal(harness.published[0].largeImageKey, "https://roon-art.example.com/art/abc123.jpg");
  assert.equal(harness.published[0].largeImageText, "Album");
});

test("radio album art does not add duplicate track text", () => {
  const harness = createHarness();
  harness.publisher.albumArtProvider = {
    getPublicUrl: () => "https://roon-art.example.com/art/radio.jpg"
  };

  const activity = harness.publisher.toDiscordRpcActivity({
    timestampMode: "RADIO",
    activity: {
      details: "Epic of Gilgamesh - Morttagua",
      state: "poly-sinc-gauss-hires-lp, SDM, DSD512",
      instance: false,
      timestamps: { start: 2_000_000 }
    },
    metadata: {
      title: "Epic of Gilgamesh",
      artist: "Morttagua",
      album: "Epic of Gilgamesh",
      albumArtUrl: "https://archive.org/epic.jpg",
      albumArtKey: "radio:morttagua|epic of gilgamesh",
      radioTrackKey: "morttagua|epic of gilgamesh",
      radioArtworkResolved: true
    }
  });

  assert.equal(activity.largeImageKey, "https://roon-art.example.com/art/radio.jpg");
  assert.equal("largeImageText" in activity, false);
});

test("stale resolved radio artwork is not sent for a different track", () => {
  const harness = createHarness();
  harness.publisher.albumArtProvider = {
    getPublicUrl: () => "https://roon-art.example.com/art/old.jpg"
  };

  const activity = harness.publisher.toDiscordRpcActivity({
    timestampMode: "RADIO",
    activity: {
      details: "Sully - Eraser",
      state: "poly-sinc-gauss-hires-lp, SDM, DSD512",
      instance: false,
      timestamps: { start: 2_000_000 }
    },
    metadata: {
      title: "Eraser",
      artist: "Sully",
      album: "Insomniac|MPACT",
      albumArtUrl: "https://archive.org/old.jpg",
      albumArtKey: "radio:morttagua|epic of gilgamesh",
      radioTrackKey: "sully|eraser",
      radioArtworkResolved: false
    }
  });

  assert.equal("largeImageKey" in activity, false);
  assert.equal("largeImageText" in activity, false);
});

test("republishLast refreshes Discord when only HQPlayer signal path changes", () => {
  const harness = createMutableSignalHarness("poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz");

  assert.equal(harness.publisher.publishZone(localZone()), true);
  harness.setSignalPath("poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
  assert.equal(harness.publisher.republishLast(), true);

  assert.equal(harness.published.length, 2);
  assert.equal(harness.published[0].state, "poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz");
  assert.equal(harness.published[1].state, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
});
