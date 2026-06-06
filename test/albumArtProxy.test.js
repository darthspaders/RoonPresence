const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { AlbumArtProxy, fetchBuffer, isUsablePublicBaseUrl } = require("../src/albumArtProxy");

test("album art proxy requires a public base URL", () => {
  assert.equal(isUsablePublicBaseUrl(""), false);
  assert.equal(isUsablePublicBaseUrl("not-a-url"), false);
  assert.equal(isUsablePublicBaseUrl("https://example.com"), true);
});

test("album art proxy returns stable public URLs without fetching immediately", () => {
  let fetchCount = 0;
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://roon-art.example.com/",
    fetchImage: async () => {
      fetchCount += 1;
      return Buffer.from("image");
    }
  });

  const first = proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc");
  const second = proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc");

  assert.equal(first, second);
  assert.match(first, /^https:\/\/roon-art\.example\.com\/art\/[a-f0-9]{40}\.jpg$/);
  assert.equal(fetchCount, 0);
});

test("album art proxy returns empty URL when no public base URL is configured", () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: ""
  });

  assert.equal(proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc"), "");
});

test("album art proxy reloads public URL config", () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "",
    port: 8787
  });

  assert.equal(
    proxy.updateConfig({
      publicBaseUrl: "https://roon-art.example.com",
      port: 8787,
      cacheMax: 40
    }),
    true
  );
  assert.equal(
    proxy.getPublicUrl("http://127.0.0.1:9100/api/image/abc", "abc").startsWith("https://roon-art.example.com/art/"),
    true
  );
  proxy.stop();
});
test("album art fetch follows HTTP redirects", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(307, { location: "/image" });
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "image/jpeg" });
    response.end("image-bytes");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const buffer = await fetchBuffer(`http://127.0.0.1:${port}/redirect`);
    assert.equal(buffer.toString("utf8"), "image-bytes");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});



test("album art proxy can prefetch and return cached public URLs", async () => {
  let fetchCount = 0;
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://art.example.com",
    fetchImage: async (url) => {
      fetchCount += 1;
      assert.equal(url, "https://resources.tidal.com/images/cover.jpg");
      return Buffer.from("image-bytes");
    }
  });

  const publicUrl = await proxy.cachePublicUrl("https://resources.tidal.com/images/cover.jpg", "radio:artist|track");
  assert.match(publicUrl, /^https:\/\/art\.example\.com\/art\/[a-f0-9]{40}\.jpg$/);
  assert.equal(fetchCount, 1);

  const sameUrl = await proxy.cachePublicUrl("https://resources.tidal.com/images/cover.jpg", "radio:artist|track");
  assert.equal(sameUrl, publicUrl);
  assert.equal(fetchCount, 1);
});

test("album art proxy does not wrap its own public URLs again", () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });
  const publicUrl = proxy.getPublicUrl("https://resources.tidal.com/images/cover.jpg", "radio:artist|track");

  assert.equal(proxy.getPublicUrl(publicUrl, "radio:artist|track"), publicUrl);
});

test("album art proxy creates TIDAL bridge URLs", () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });

  assert.equal(
    proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345"),
    "https://art.example.com/tidal/track/12345"
  );
  assert.equal(
    proxy.getTidalBridgeUrl(
      "https://tidal.com/browse/track/12345",
      "manual",
      "https://art.example.com/art/cover.jpg",
      { title: "Unfolding", artist: "Eric Olivier Mario" }
    ),
    "https://art.example.com/tidal/track/12345"
  );
  assert.equal(proxy.getTidalBridgeUrl("https://tidal.com/search?q=test"), "");
});

test("album art proxy serves clean public TIDAL track pages", async () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://art.example.com",
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-tidal-"))
  });
  const chunks = [];
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await proxy.handleRequest({
    url: "/tidal/track/12345?art=https%3A%2F%2Fart.example.com%2Fart%2Fcover.jpg&title=Unfolding&artist=Eric%20Olivier%20Mario",
    headers: {
      host: "art.example.com",
      "x-forwarded-proto": "https"
    }
  }, response);

  const html = Buffer.concat(chunks).toString("utf8");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(html, /Unfolding/);
  assert.match(html, /Eric Olivier Mario/);
  assert.match(html, /rel="canonical" href="https:\/\/art\.example\.com\/tidal\/track\/12345"/);
  assert.match(html, /property="og:url" content="https:\/\/art\.example\.com\/tidal\/track\/12345/);
  assert.match(html, /Share/);
  assert.match(html, /Copy link/);
  assert.match(html, /shareUrl="https:\/\/art\.example\.com\/tidal\/track\/12345"/);
});

test("album art proxy creates TIDAL intent and scheme bridge URLs", () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });

  assert.equal(
    proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345", "intent"),
    "https://art.example.com/tidal/intent/12345"
  );
  assert.equal(
    proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345", "android"),
    "https://art.example.com/tidal/intent/12345"
  );
  assert.equal(
    proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345", "scheme"),
    "https://art.example.com/tidal/app/12345"
  );
  assert.equal(
    proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345", "manual"),
    "https://art.example.com/tidal/track/12345"
  );
  assert.equal(proxy.getTidalBridgeUrl("https://tidal.com/browse/track/12345", "web"), "");
});

test("album art proxy redirects TIDAL intent endpoint", async () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });
  const response = {
    status: null,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {}
  };

  await proxy.handleRequest({ url: "/tidal/intent/12345" }, response);

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^intent:\/\/track\/12345#Intent;scheme=tidal;package=com\.aspiro\.tidal;/);
  assert.match(response.headers.location, /browser_fallback_url=https%3A%2F%2Ftidal.com%2Fbrowse%2Ftrack%2F12345/);
});

test("album art proxy redirects TIDAL scheme endpoint", async () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });
  const response = {
    status: null,
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {}
  };

  await proxy.handleRequest({ url: "/tidal/app/12345" }, response);

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "tidal://track/12345");
});

test("album art proxy ingests manual TIDAL metadata and redirects to clean URL", async () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://art.example.com",
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-tidal-"))
  });
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {}
  };

  await proxy.handleRequest({ url: "/tidal/manual/12345?art=https%3A%2F%2Fart.example.com%2Fart%2Fcover.jpg&title=Unfolding&artist=Eric%20Olivier%20Mario" }, response);

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/tidal/track/12345");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(proxy.getTidalBridgeMetadata("12345"), {
    title: "Unfolding",
    artist: "Eric Olivier Mario",
    albumArtUrl: "https://art.example.com/art/cover.jpg",
    tidalUrl: "https://tidal.com/browse/track/12345",
    updatedAt: proxy.getTidalBridgeMetadata("12345").updatedAt
  });
});

test("album art proxy serves manual TIDAL landing page UI from clean track URL", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-tidal-"));
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com", cacheDir });
  proxy.rememberTidalBridgeMetadata("12345", {
    title: "Unfolding",
    artist: "Eric Olivier Mario",
    albumArtUrl: "https://art.example.com/art/cover.jpg",
    tidalUrl: "https://tidal.com/browse/track/12345"
  });
  const chunks = [];
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await proxy.handleRequest({
    url: "/tidal/track/12345",
    headers: {
      host: "art.example.com",
      "x-forwarded-proto": "https"
    }
  }, response);

  const html = Buffer.concat(chunks).toString("utf8");
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /1\. Wake TIDAL/);
  assert.doesNotMatch(html, /TIDAL is sleeping/);
  assert.doesNotMatch(html, /Try Track App Link/);
  assert.doesNotMatch(html, /Open TIDAL Web/);
  assert.doesNotMatch(html, /createElement\("iframe"\)/);
  assert.match(html, /waitingForWake/);
  assert.match(html, /sentAfterWake/);
  assert.match(html, /cover\.addEventListener\("click",handleOpen\)/);
  assert.match(html, /900/);
  assert.match(html, /350/);
  assert.match(html, /place-items:center/);
  assert.match(html, /class="shell"/);
  assert.match(html, /class="brand"/);
  assert.match(html, /darthspader\.com/);
  assert.doesNotMatch(html, /class="brand-bars"/);
  assert.match(html, /backdrop-filter:blur\(18px\)/);
  assert.match(html, /transform:translateY\(-5vh\)/);
  assert.match(html, /class="cover-wrap"/);
  assert.match(html, /id="cover-link"/);
  assert.match(html, /aria-label="Play on TIDAL"/);
  assert.match(html, /class="background-art" src="https:\/\/art\.example\.com\/art\/cover\.jpg"/);
  assert.match(html, /class="cover-art" src="https:\/\/art\.example\.com\/art\/cover\.jpg"/);
  assert.match(html, /object-fit:cover/);
  assert.match(html, /filter:blur\(28px\)/);
  assert.match(html, /opacity:\.38/);
  assert.match(html, /width:min\(58vw,228px\)/);
  assert.match(html, /rgba\(255,255,255,\.64\)/);
  assert.match(html, /rgba\(0,0,0,\.54\)/);
  assert.match(html, /rgba\(255,186,90,\.08\)/);
  assert.match(html, /radial-gradient/);
  assert.match(html, /<title>Unfolding - Eric Olivier Mario<\/title>/);
  assert.match(html, /property="og:title" content="Unfolding - Eric Olivier Mario"/);
  assert.match(html, /property="og:image" content="https:\/\/art\.example\.com\/art\/cover\.jpg"/);
  assert.match(html, /property="og:url" content="https:\/\/art\.example\.com\/tidal\/track\/12345"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /rel="canonical" href="https:\/\/art\.example\.com\/tidal\/track\/12345"/);
  assert.match(html, /Unfolding/);
  assert.match(html, /Eric Olivier Mario/);
  assert.doesNotMatch(html, /Open in TIDAL/);
  assert.doesNotMatch(html, /Open Track in TIDAL/);
  assert.match(html, /Play on/);
  assert.match(html, /\/assets\/tidal-logo\.png/);
  assert.match(html, /class="tidal-button"/);
  assert.match(html, /class="tidal-logo"/);
  assert.match(html, /class="music-links"/);
  assert.match(html, /id="spotify-search"/);
  assert.match(html, /id="apple-search"/);
  assert.match(html, /\/assets\/spotify-full-logo\.png/);
  assert.match(html, /\/assets\/apple-music-logo\.png/);
  assert.match(html, /class="music-link apple-link"/);
  assert.match(html, /aria-label="Search on Spotify"/);
  assert.match(html, /aria-label="Search on Apple Music"/);
  assert.match(html, /https:\/\/open\.spotify\.com\/search\/Unfolding%20Eric%20Olivier%20Mario/);
  assert.match(html, /https:\/\/music\.apple\.com\/us\/search\?term=Unfolding%20Eric%20Olivier%20Mario/);
  assert.match(html, /spotify:search:Unfolding%20Eric%20Olivier%20Mario/);
  assert.match(html, /intent:\/\/search\/Unfolding%20Eric%20Olivier%20Mario#Intent;scheme=spotify;package=com\.spotify\.music/);
  assert.match(html, /music:\/\/music\.apple\.com\/us\/search\?term=Unfolding%20Eric%20Olivier%20Mario/);
  assert.doesNotMatch(html, /package=com\.apple\.android\.music/);
  assert.match(html, /openMusicApp\(event,appleWebUrl,appleAppUrl,appleWebUrl\)/);
  assert.match(html, /openMusicApp/);
  assert.match(html, /class="share-actions"/);
  assert.match(html, /Share/);
  assert.match(html, /Copy link/);
  assert.match(html, /navigator\.share/);
  assert.match(html, /navigator\.clipboard/);
  assert.doesNotMatch(html, /class="tidal-mark"/);
  assert.match(html, /intent:\/\/tidal.com\/browse\/track\/12345/);
  assert.match(html, /tidal:\/\/track\/12345/);
  assert.doesNotMatch(html, /tidal:\/\/tracks\/12345/);
  assert.doesNotMatch(html, /intent:\/\/track\/12345/);
  assert.match(html, /intent:\/\/#Intent;scheme=tidal;package=com\.aspiro\.tidal/);
  assert.match(html, /android.intent.action.VIEW/);
});

test("album art proxy manual TIDAL page falls back to plain black background without artwork", async () => {
  const proxy = new AlbumArtProxy({
    publicBaseUrl: "https://art.example.com",
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-tidal-"))
  });
  const chunks = [];
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await proxy.handleRequest({ url: "/tidal/track/12345" }, response);

  const html = Buffer.concat(chunks).toString("utf8");
  assert.match(html, /background:#020202/);
  assert.doesNotMatch(html, /class="background-art"/);
  assert.doesNotMatch(html, /class="cover-art"/);
  assert.doesNotMatch(html, /class="cover-wrap"/);
  assert.match(html, /darthspader\.com/);
  assert.doesNotMatch(html, /DARTHSPADER\.COM/);
  assert.match(html, /Ready in TIDAL/);
});

test("album art proxy persists TIDAL bridge metadata for public shared URLs", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "roonpresence-tidal-"));
  const firstProxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com", cacheDir });
  const bridgeUrl = firstProxy.getTidalBridgeUrl(
    "https://tidal.com/browse/track/12345",
    "manual",
    "https://art.example.com/art/cover.jpg",
    { title: "Unfolding", artist: "Eric Olivier Mario" }
  );
  assert.equal(
    bridgeUrl,
    "https://art.example.com/tidal/track/12345"
  );

  const secondProxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com", cacheDir });
  const chunks = [];
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await secondProxy.handleRequest(
    {
      url: "/tidal/track/12345",
      headers: {
        host: "art.example.com",
        "x-forwarded-proto": "https"
      }
    },
    response
  );

  const html = Buffer.concat(chunks).toString("utf8");
  assert.equal(response.status, 200);
  assert.match(html, /Unfolding/);
  assert.match(html, /Eric Olivier Mario/);
  assert.match(html, /class="background-art" src="https:\/\/art\.example\.com\/art\/cover\.jpg"/);
  assert.match(html, /property="og:url" content="https:\/\/art\.example\.com\/tidal\/track\/12345"/);
  assert.match(html, /property="og:image" content="https:\/\/art\.example\.com\/art\/cover\.jpg"/);
});

test("album art proxy serves bridge page image assets", async () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });

  for (const assetPath of ["/assets/tidal-logo.png", "/assets/spotify-full-logo.png", "/assets/apple-music-logo.png"]) {
    const chunks = [];
    const response = {
      headers: null,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
      }
    };

    await proxy.handleRequest({ url: assetPath }, response);

    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["cache-control"], "public, max-age=86400");
    assert.equal(Buffer.concat(chunks).length > 0, true);
  }
});

test("album art proxy serves personal now playing feed", async () => {
  const proxy = new AlbumArtProxy({ publicBaseUrl: "https://art.example.com" });
  proxy.updateNowPlaying(
    {
      timestampMode: "RADIO",
      activity: {
        details: "Cheyenne (Extended Mix)",
        state: "poly-sinc-gauss-hires-lp, PCM, 768kHz"
      },
      metadata: {
        title: "Cheyenne (Extended Mix)",
        artist: "Trilucid",
        radioStationName: "Progressive House - DI.FM",
        signalPath: "poly-sinc-gauss-hires-lp, PCM, 768kHz"
      }
    },
    {
      largeImageKey: "https://art.example.com/art/cover.jpg",
      buttons: [{ label: "Play on TIDAL", url: "https://art.example.com/tidal/track/12345" }]
    }
  );

  const chunks = [];
  const response = {
    headers: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };

  await proxy.handleRequest({ url: "/now" }, response);

  const html = Buffer.concat(chunks).toString("utf8");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.match(html, /Now Playing/);
  assert.match(html, /Cheyenne \(Extended Mix\)/);
  assert.match(html, /Trilucid/);
  assert.match(html, /poly-sinc-gauss-hires-lp, PCM, 768kHz/);
  assert.match(html, /https:\/\/art\.example\.com\/art\/cover\.jpg/);
  assert.match(html, /https:\/\/art\.example\.com\/tidal\/track\/12345/);
  assert.match(html, /Recently Played/);
});

