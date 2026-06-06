const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RadioMetadataResolver,
  chooseCoverImage,
  chooseDiscogsResult,
  chooseTidalTrack,
  tidalCoverUrlFromUuid,
  extractTidalWebArtwork,
  stripGuestCredit,
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
test("parses Progressive DI.FM artist-title subtitle", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "Progressive -DI.FM",
      artist: "Ultraverse - Covenant (Original Mix)",
      album: "DI.FM"
    }),
    { artist: "Ultraverse", title: "Covenant (Original Mix)" }
  );
});

test("parses radio track from activity state fallback", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "Covenant (Original Mix)",
      artist: "Progressive -DI.FM",
      album: "Progressive -DI.FM",
      activityState: "Ultraverse - Covenant (Original Mix)"
    }),
    { artist: "Ultraverse", title: "Covenant (Original Mix)" }
  );
});

test("combines split station title, track, and artist fields", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "Progressive -DI.FM",
      artist: "Covenant (Original Mix)",
      album: "Ultraverse"
    }),
    { artist: "Ultraverse", title: "Covenant (Original Mix)" }
  );
});
test("parses multi-artist DI.FM subtitle artist first", () => {
  assert.deepEqual(
    parseRadioTrack({
      title: "Progressive -DI.FM",
      artist: "Ivan Berkowitz, Messier - Fountain (Ivan Berkowitz Remix)",
      album: "Progressive -DI.FM"
    }),
    { artist: "Ivan Berkowitz, Messier", title: "Fountain (Ivan Berkowitz Remix)" }
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

test("chooses usable Discogs cover image", () => {
  assert.deepEqual(
    chooseDiscogsResult({
      results: [
        { title: "Spacer", cover_image: "https://st.discogs.com/images/spacer.gif" },
        { title: "PRAANA - Asylum", cover_image: "https://img.discogs.com/asylum.jpg" }
      ]
    }),
    { title: "PRAANA - Asylum", coverImage: "https://img.discogs.com/asylum.jpg" }
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
test("resolver can use Spotify artwork when explicitly enabled and TIDAL is disabled", async () => {
  const requested = [];
  const tokenRequests = [];
  const cached = [];
  const resolver = new RadioMetadataResolver({
    spotifyArtworkEnabled: true,
    tidalArtworkEnabled: false,
    spotifyClientId: "spotify-client",
    spotifyClientSecret: "spotify-secret",
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        return "https://art.example.com/art/spotify.jpg";
      }
    },
    fetchImpl: async (url, options) => {
      tokenRequests.push({ url, options, body: Object.fromEntries(options.body.entries()) });
      return {
        ok: true,
        json: async () => ({ access_token: "spotify-token", expires_in: 3600 })
      };
    },
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      assert.equal(url.startsWith("https://api.spotify.com/v1/search"), true);
      assert.equal(options.headers.authorization, "Bearer spotify-token");
      return {
        tracks: {
          items: [
            {
              name: "Control (Original Mix)",
              duration_ms: 420000,
              artists: [{ name: "Ziger" }],
              external_urls: { spotify: "https://open.spotify.com/track/spotify-track" },
              album: {
                name: "Control",
                images: [
                  { url: "https://i.scdn.co/image/spotify-cover", width: 640, height: 640 }
                ]
              }
            }
          ]
        }
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "Ziger", title: "Control (Original Mix)" },
    "ziger|control original mix"
  );

  assert.equal(result.source, "spotify");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/spotify.jpg");
  assert.equal(result.spotifyUrl, "https://open.spotify.com/track/spotify-track");
  assert.equal(result.durationMs, 420000);
  assert.equal(tokenRequests.length, 1);
  assert.equal(requested.length, 1);
  assert.deepEqual(cached, [
    {
      sourceUrl: "https://i.scdn.co/image/spotify-cover",
      imageKey: "radio:ziger|control original mix"
    }
  ]);
});

test("resolver prefers TIDAL artwork before Discogs", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    discogsToken: "secret-token",
    fetchJson: async (url) => {
      requested.push(url);
      assert.equal(url.startsWith("https://openapi.tidal.com/v2/searchResults/"), true);
      return {
        items: [
          {
            title: "Indian Spirit",
            artists: [{ name: "E-Clip" }],
            album: {
              title: "Indian Spirit",
              cover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.albumArtUrl, "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg");
  assert.equal(requested.length, 1);
});




test("resolver matches TIDAL artwork using title-artist fallback and base mix title", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    fetchJson: async (url) => {
      requested.push(decodeURIComponent(url));
      if (!decodeURIComponent(url).includes("Running (Extended Mix) Parallel Voices")) {
        return { items: [] };
      }
      return {
        items: [
          {
            title: "Running",
            artists: [{ name: "Parallel Voices" }],
            album: {
              title: "Running",
              cover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "Parallel Voices", title: "Running (Extended Mix)" },
    "parallel voices|running extended mix"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.albumArtUrl, "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg");
  assert.equal(requested.some((url) => url.includes("Parallel Voices Running (Extended Mix)")), true);
  assert.equal(requested.some((url) => url.includes("Running (Extended Mix) Parallel Voices")), true);
});

test("resolver follows TIDAL data order instead of unrelated included tracks", async () => {
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    fetchJson: async () => ({
      data: [{ id: "wanted-track", type: "tracks" }],
      included: [
        {
          id: "noise-track",
          type: "tracks",
          attributes: { title: "Right Back to You (Extended Version)", duration: 300 },
          relationships: {
            artists: { data: [{ id: "noise-artist", type: "artists" }] },
            albums: { data: [{ id: "noise-album", type: "albums" }] }
          }
        },
        {
          id: "wanted-track",
          type: "tracks",
          attributes: { title: "Running (ABGT478)", duration: 240 },
          relationships: {
            artists: { data: [{ id: "wanted-artist", type: "artists" }] },
            albums: { data: [{ id: "wanted-album", type: "albums" }] }
          }
        },
        { id: "noise-artist", type: "artists", attributes: { name: "Wrong Artist" } },
        { id: "wanted-artist", type: "artists", attributes: { name: "Parallel Voices" } },
        { id: "wanted-album", type: "albums", attributes: { title: "Running", imageCover: "12345678-abcd-4321-9000-123456789abc" } }
      ]
    })
  });

  const result = await resolver.lookup(
    { artist: "Parallel Voices", title: "Running (Extended Mix)" },
    "parallel voices|running extended mix"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.album, "Running");
  assert.equal(result.albumArtUrl, "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg");
});
test("resolver parses TIDAL open API search relationships", async () => {
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    fetchJson: async (url, options = {}) => {
      assert.equal(url.startsWith("https://openapi.tidal.com/v2/searchResults/"), true);
      assert.equal(options.headers.authorization, "Bearer token");
      return {
        data: [{ id: "track-1", type: "tracks" }],
        included: [
          {
            id: "track-1",
            type: "tracks",
            attributes: { title: "Indian Spirit", duration: 300, externalLinks: [{ href: "https://tidal.com/browse/track/12345", meta: { type: "TIDAL_SHARING" } }] },
            relationships: {
              artists: { data: [{ id: "artist-1", type: "artists" }] },
              albums: { data: [{ id: "album-1", type: "albums" }] }
            }
          },
          { id: "artist-1", type: "artists", attributes: { name: "E-Clip" } },
          {
            id: "album-1",
            type: "albums",
            attributes: {
              title: "Indian Spirit",
              imageCover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.album, "Indian Spirit");
  assert.equal(result.durationMs, 300_000);
  assert.equal(result.albumArtUrl, "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg");
});
test("resolver fetches and caches a TIDAL token from client credentials", async () => {
  const requested = [];
  const tokenRequests = [];
  let now = 1_780_000_000_000;
  const resolver = new RadioMetadataResolver({
    tidalClientId: "client-id",
    tidalClientSecret: "client-secret",
    clock: () => now,
    fetchImpl: async (url, options) => {
      tokenRequests.push({ url, options, body: Object.fromEntries(options.body.entries()) });
      return {
        ok: true,
        json: async () => ({ access_token: "fresh-token", expires_in: 3600 })
      };
    },
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      assert.equal(options.headers.authorization, "Bearer fresh-token");
      return {
        items: [
          {
            title: "Indian Spirit",
            duration: 300,
            artists: [{ name: "E-Clip" }],
            album: {
              title: "Indian Spirit",
              cover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const first = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );
  now += 30_000;
  const second = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(first.source, "tidal");
  assert.equal(first.durationMs, 300_000);
  assert.equal(second.source, "tidal");
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].url, "https://auth.tidal.com/v1/oauth2/token");
  assert.equal(tokenRequests[0].body.grant_type, "client_credentials");
  assert.match(tokenRequests[0].options.headers.authorization, /^Basic /);
  assert.equal(requested.length, 2);
});

test("resolver prefers TIDAL client credentials over manual access token", async () => {
  const requested = [];
  const tokenRequests = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "old-manual-token",
    tidalClientId: "client-id",
    tidalClientSecret: "client-secret",
    fetchImpl: async (url, options) => {
      tokenRequests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ access_token: "fresh-token", expires_in: 3600 })
      };
    },
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      assert.equal(options.headers.authorization, "Bearer fresh-token");
      return {
        items: [
          {
            title: "Indian Spirit",
            artists: [{ name: "E-Clip" }],
            album: {
              title: "Indian Spirit",
              cover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "tidal");
  assert.equal(tokenRequests.length, 1);
  assert.equal(requested.length, 1);
});

test("resolver ignores stale manual token when client credentials are configured", async () => {
  const requested = [];
  const tokenRequests = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "stale-token",
    tidalClientId: "client-id",
    tidalClientSecret: "client-secret",
    fetchImpl: async (url, options) => {
      tokenRequests.push({ url, options, body: Object.fromEntries(options.body.entries()) });
      return {
        ok: true,
        json: async () => ({ access_token: "fresh-token", expires_in: 3600 })
      };
    },
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      if (options.headers.authorization === "Bearer stale-token") {
        const error = new Error("HTTP 401");
        error.status = 401;
        throw error;
      }
      assert.equal(options.headers.authorization, "Bearer fresh-token");
      return {
        items: [
          {
            title: "Indian Spirit",
            artists: [{ name: "E-Clip" }],
            album: {
              title: "Indian Spirit",
              cover: "12345678-abcd-4321-9000-123456789abc"
            }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "tidal");
  assert.equal(tokenRequests.length, 1);
  assert.equal(requested.length, 1);
});
test("resolver follows TIDAL track detail when search omits artwork", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    fetchJson: async (url) => {
      requested.push(decodeURIComponent(url));
      if (url.startsWith("https://openapi.tidal.com/v2/tracks/220102344")) {
        return {
          data: {
            id: "220102344",
            type: "tracks",
            attributes: { title: "New Dawn (Extended Mix)", duration: 390 },
            relationships: {
              albums: { data: [{ id: "220102342", type: "albums" }] },
              artists: { data: [{ id: "artist-1", type: "artists" }] }
            }
          },
          included: [
            { id: "artist-1", type: "artists", attributes: { name: "Sean & Dee" } },
            {
              id: "220102342",
              type: "albums",
              attributes: {
                title: "New Dawn",
                imageCover: "12345678-abcd-4321-9000-123456789abc"
              }
            }
          ]
        };
      }
      if (!decodeURIComponent(url).includes("Sean Dee New Dawn (Extended Mix)")) {
        return { data: [], included: [] };
      }
      return {
        data: [{ id: "220102344", type: "tracks" }],
        included: [
          {
            id: "220102344",
            type: "tracks",
            attributes: { title: "New Dawn (Extended Mix)", duration: 390 }
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "Sean & Dee", title: "New Dawn (Extended Mix)" },
    "sean dee|new dawn extended mix"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.album, "New Dawn");
  assert.equal(result.durationMs, 390_000);
  assert.equal(result.albumArtUrl, "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg");
  assert.equal(requested.some((url) => url.includes("Sean Dee New Dawn (Extended Mix)")), true);
  assert.equal(requested.some((url) => url.includes("/v2/tracks/220102344")), true);
});

test("strips guest credits while preserving remix text", () => {
  assert.equal(
    stripGuestCredit("D?j? Vu (feat. Molly Moonwater) [Julian Schwarz Remix]"),
    "D?j? Vu [Julian Schwarz Remix]"
  );
});

test("extracts TIDAL artwork from web page text", () => {
  assert.equal(
    extractTidalWebArtwork('{"imageCover":"12345678-abcd-4321-9000-123456789abc"}'),
    "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"
  );
  assert.equal(
    extractTidalWebArtwork('https:\\/\\/resources.tidal.com\\/images\\/12345678\\/abcd\\/4321\\/9000\\/123456789abc\\/640x640.jpg'),
    "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"
  );
});

test("resolver tries guest-credit-cleaned TIDAL web search", async () => {
  const fetched = [];
  const resolver = new RadioMetadataResolver({
    tidalSearchBaseUrl: "https://tidal.com/search?q=",
    albumArtProvider: {
      cachePublicUrl: async () => "https://art.example.com/art/rinzen.jpg"
    },
    fetchImpl: async (url) => {
      fetched.push(decodeURIComponent(url));
      const hasCleaned = decodeURIComponent(url).includes("Rinzen D?j? Vu [Julian Schwarz Remix]");
      return {
        ok: true,
        text: async () => hasCleaned
          ? "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"
          : "<html></html>"
      };
    },
    fetchJson: async () => {
      throw new Error("API should not be called when cleaned web artwork resolves");
    }
  });

  const result = await resolver.lookup(
    { artist: "Rinzen", title: "D?j? Vu (feat. Molly Moonwater) [Julian Schwarz Remix]" },
    "rinzen|deja vu feat molly moonwater julian schwarz remix"
  );

  assert.equal(result.source, "tidal-web");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/rinzen.jpg");
  assert.equal(fetched.some((url) => url.includes("Rinzen D?j? Vu [Julian Schwarz Remix]")), true);
});


test("resolver tries single artist aliases before full comma artist for TIDAL web artwork", async () => {
  const fetched = [];
  const resolver = new RadioMetadataResolver({
    tidalSearchBaseUrl: "https://tidal.com/search?q=",
    albumArtProvider: {
      cachePublicUrl: async () => "https://art.example.com/art/through-darkness.jpg"
    },
    fetchImpl: async (url) => {
      fetched.push(decodeURIComponent(url));
      if (!decodeURIComponent(url).includes("Ghostbeat Through The Darkness (Original Mix)")) {
        return { ok: true, text: async () => "<html></html>" };
      }
      return {
        ok: true,
        text: async () => '<html><a href="/browse/track/12345">play</a><img src="https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"></html>'
      };
    },
    fetchJson: async () => {
      throw new Error("API should not be called when web artwork resolves");
    }
  });

  const result = await resolver.lookup(
    { artist: "Ghostbeat,LTN", title: "Through The Darkness (Original Mix)" },
    "ghostbeat ltn|through the darkness original mix"
  );

  assert.equal(result.source, "tidal-web");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/through-darkness.jpg");
  assert.equal(fetched[0], "https://tidal.com/search?q=Ghostbeat,LTN Through The Darkness (Original Mix)");
  assert.equal(fetched.some((url) => url.includes("Ghostbeat Through The Darkness (Original Mix)")), true);
});

test("resolver uses TIDAL web artwork through album art proxy before API lookup", async () => {
  const fetched = [];
  const cached = [];
  const resolver = new RadioMetadataResolver({
    tidalSearchBaseUrl: "https://tidal.com/search?q=",
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        return "https://art.example.com/art/tidal-web.jpg";
      }
    },
    fetchImpl: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        text: async () => '<html><a href="/browse/track/12345">play</a><img src="https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"></html>'
      };
    },
    fetchJson: async () => {
      throw new Error("API should not be called when web artwork resolves");
    }
  });

  const result = await resolver.lookup(
    { artist: "Ritchie Haydn", title: "In A Dream (Club Mix)" },
    "ritchie haydn|in a dream club mix"
  );

  assert.equal(result.source, "tidal-web");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/tidal-web.jpg");
  assert.equal(result.tidalUrl, "https://tidal.com/browse/track/12345");
  assert.equal(fetched[0], "https://tidal.com/search?q=Ritchie%20Haydn%20In%20A%20Dream%20(Club%20Mix)");
  assert.deepEqual(cached, [
    {
      sourceUrl: "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg",
      imageKey: "radio:ritchie haydn|in a dream club mix"
    }
  ]);
});

test("resolver follows TIDAL album coverArt relationship when search omits artwork", async () => {
  const requested = [];
  const cached = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        return "https://art.example.com/art/tidal-coverart.jpg";
      }
    },
    fetchImpl: async () => ({ ok: true, text: async () => "<html></html>" }),
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      assert.equal(options.headers.authorization, "Bearer token");
      if (url.startsWith("https://openapi.tidal.com/v2/searchResults/")) {
        return {
          data: [{ id: "track-1", type: "tracks" }],
          included: [
            {
              id: "track-1",
              type: "tracks",
              attributes: { title: "Skin (Rinzen Remix)", duration: 389, externalLinks: [{ href: "https://tidal.com/browse/track/12345", meta: { type: "TIDAL_SHARING" } }] },
              relationships: { albums: { data: [{ id: "album-1", type: "albums" }] } }
            }
          ]
        };
      }
      if (url.startsWith("https://openapi.tidal.com/v2/tracks/track-1")) {
        return {
          data: {
            id: "track-1",
            type: "tracks",
            attributes: { title: "Skin (Rinzen Remix)", duration: 389 },
            relationships: { albums: { data: [{ id: "album-1", type: "albums" }] } }
          }
        };
      }
      if (url.startsWith("https://openapi.tidal.com/v2/albums/album-1")) {
        return {
          data: {
            id: "album-1",
            type: "albums",
            attributes: { title: "Skin (Rinzen Remix)" },
            relationships: { coverArt: { data: [{ id: "art-1", type: "artworks" }] } }
          },
          included: [
            {
              id: "art-1",
              type: "artworks",
              attributes: { files: [{ url: "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg" }] }
            }
          ]
        };
      }
      return { data: [], included: [] };
    }
  });

  const result = await resolver.lookup(
    { artist: "Kidnap", title: "Skin (Rinzen Remix)" },
    "kidnap|skin rinzen remix"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.album, "Skin (Rinzen Remix)");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/tidal-coverart.jpg");
  assert.equal(result.durationMs, 389_000);
  assert.equal(result.tidalUrl, "https://tidal.com/browse/track/12345");
  assert.equal(requested.some((entry) => entry.url.startsWith("https://openapi.tidal.com/v2/albums/album-1")), true);
  assert.deepEqual(cached, [
    {
      sourceUrl: "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg",
      imageKey: "radio:kidnap|skin rinzen remix"
    }
  ]);
});

test("resolver uses TIDAL v1 search artwork through album art proxy", async () => {
  const requested = [];
  const cached = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        return "https://art.example.com/art/kidnap.jpg";
      }
    },
    fetchImpl: async () => ({ ok: true, text: async () => "<html></html>" }),
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      if (url.startsWith("https://api.tidal.com/v1/search/tracks")) {
        assert.equal(options.headers.authorization, "Bearer token");
        return {
          items: [
            {
              id: 12345,
              title: "Skin (Rinzen Remix)",
              duration: 389,
              url: "https://tidal.com/browse/track/12345",
              artists: [{ name: "Kidnap" }],
              album: {
                title: "Skin (Rinzen Remix)",
                cover: "12345678-abcd-4321-9000-123456789abc"
              }
            }
          ]
        };
      }
      return { data: [], included: [] };
    }
  });

  const result = await resolver.lookup(
    { artist: "Kidnap", title: "Skin (Rinzen Remix)" },
    "kidnap|skin rinzen remix"
  );

  assert.equal(result.source, "tidal-v1");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/kidnap.jpg");
  assert.equal(result.tidalUrl, "https://tidal.com/browse/track/12345");
  assert.equal(requested.some((entry) => entry.url.startsWith("https://api.tidal.com/v1/search/tracks")), true);
  assert.deepEqual(cached, [
    {
      sourceUrl: "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg",
      imageKey: "radio:kidnap|skin rinzen remix"
    }
  ]);
});

test("resolver caches TIDAL artwork through album art proxy", async () => {
  const cached = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        return "https://art.example.com/art/cached.jpg";
      }
    },
    fetchJson: async () => ({
      items: [
        {
          title: "Indian Spirit",
          artists: [{ name: "E-Clip" }],
          album: {
            title: "Indian Spirit",
            cover: "12345678-abcd-4321-9000-123456789abc"
          }
        }
      ]
    })
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "tidal");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/cached.jpg");
  assert.deepEqual(cached, [
    {
      sourceUrl: "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg",
      imageKey: "radio:e-clip|indian spirit"
    }
  ]);
});

test("resolver falls back when TIDAL artwork cannot be cached through proxy", async () => {
  const warnings = [];
  const requested = [];
  const cached = [];
  const resolver = new RadioMetadataResolver({
    tidalAccessToken: "token",
    discogsToken: "discogs-token",
    logger: { warn: (message, data) => warnings.push({ message, data }), debug: () => {} },
    albumArtProvider: {
      cachePublicUrl: async (sourceUrl, imageKey) => {
        cached.push({ sourceUrl, imageKey });
        if (sourceUrl.includes("resources.tidal.com")) throw new Error("");
        return "https://art.example.com/art/discogs.jpg";
      }
    },
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("openapi.tidal.com")) {
        return {
          items: [
            {
              title: "Indian Spirit",
              artists: [{ name: "E-Clip" }],
              album: { title: "Indian Spirit", cover: "12345678-abcd-4321-9000-123456789abc" }
            }
          ]
        };
      }
      if (url.includes("discogs.com")) {
        return { results: [{ title: "E-Clip - Indian Spirit", cover_image: "https://img.discogs.com/indian-spirit.jpg" }] };
      }
      return {};
    }
  });

  const result = await resolver.lookup(
    { artist: "E-Clip", title: "Indian Spirit" },
    "e-clip|indian spirit"
  );

  assert.equal(result.source, "discogs");
  assert.equal(result.albumArtUrl, "https://art.example.com/art/discogs.jpg");
  assert.equal(warnings[0].message, "Album art proxy cache failed");
  assert.equal(warnings[0].data.error, "Error");
  assert.equal(warnings[0].data.sourceHost, "resources.tidal.com");
  assert.equal(cached.some((entry) => entry.sourceUrl.includes("resources.tidal.com")), true);
  assert.equal(cached.some((entry) => entry.sourceUrl === "https://img.discogs.com/indian-spirit.jpg"), true);
  assert.equal(requested.some((url) => url.includes("discogs.com")), true);
});

test("formats TIDAL cover UUIDs", () => {
  assert.equal(
    tidalCoverUrlFromUuid("12345678-abcd-4321-9000-123456789abc"),
    "https://resources.tidal.com/images/12345678/abcd/4321/9000/123456789abc/640x640.jpg"
  );
});

test("resolver prefers Discogs artwork when token is configured", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalArtworkEnabled: false,
    discogsToken: "secret-token",
    fetchJson: async (url, options = {}) => {
      requested.push({ url, options });
      assert.equal(url.startsWith("https://api.discogs.com/database/search"), true);
      assert.equal(options.headers.authorization, "Discogs token=secret-token");
      return {
        results: [
          {
            title: "PRAANA - Asylum",
            cover_image: "https://img.discogs.com/asylum.jpg"
          }
        ]
      };
    }
  });

  const result = await resolver.lookup(
    { artist: "PRAANA", title: "Asylum" },
    "praana|asylum"
  );

  assert.equal(result.source, "discogs");
  assert.equal(result.albumArtUrl, "https://img.discogs.com/asylum.jpg");
  assert.equal(result.album, "PRAANA - Asylum");
  assert.equal(requested.length, 1);
});

test("Discogs miss falls back to MusicBrainz artwork", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalArtworkEnabled: false,
    discogsToken: "secret-token",
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes("discogs.com")) return { results: [] };
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

  assert.equal(result.albumArtUrl, "https://archive.org/whisper.jpg");
  assert.equal(requested.some((url) => url.includes("discogs.com")), true);
  assert.equal(requested.some((url) => url.includes("musicbrainz.org")), true);
});

test("resolver looks up MusicBrainz and Cover Art Archive metadata", async () => {
  const requested = [];
  const resolver = new RadioMetadataResolver({
    tidalArtworkEnabled: false,
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
  assert.equal(presence.activity.details, "E-Clip - Indian Spirit");
  assert.equal(presence.activity.state, "04 Progressive Psy - DI.FM Premium");
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
    tidalArtworkEnabled: false,
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

test("Discogs result rejects same title from wrong artist", () => {
  assert.equal(
    chooseDiscogsResult(
      {
        results: [
          {
            title: "DJ Different - Tides Of Time",
            cover_image: "https://img.discogs.com/wrong.jpg"
          }
        ]
      },
      { artist: "Pedro Aviles", title: "Tides Of Time" }
    ),
    null
  );
});

test("Discogs result accepts matching artist and title", () => {
  assert.deepEqual(
    chooseDiscogsResult(
      {
        results: [
          {
            title: "Pedro Aviles - Tides Of Time",
            cover_image: "https://img.discogs.com/right.jpg"
          }
        ]
      },
      { artist: "Pedro Aviles", title: "Tides Of Time" }
    ),
    { title: "Pedro Aviles - Tides Of Time", coverImage: "https://img.discogs.com/right.jpg" }
  );
});

