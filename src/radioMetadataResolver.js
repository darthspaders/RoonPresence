const EventEmitter = require("events");

const DEFAULT_MIN_LOOKUP_INTERVAL_MS = 1500;
const DEFAULT_CACHE_MAX = 200;
const USER_AGENT = "RoonPresence/0.1.0 (https://github.com/darthspaders/RoonPresence)";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeKeyPart(value) {
  return cleanText(value).toLowerCase();
}

function isStationText(value) {
  return /\b(?:di\.?fm|radio|house|trance|progressive|channel|station|live|insomniac|mpact|impact|bangers|psy)\b|\|/i.test(cleanText(value));
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function cleanStationName(value) {
  const text = cleanText(value);
  if (!isStationText(text)) return "";

  for (const separator of [" - ", " \u2013 ", " \u2014 "]) {
    if (!text.includes(separator)) continue;
    const [left, ...rest] = text.split(separator);
    const right = rest.join(separator);
    if (text.includes("|") || !isStationText(right)) return cleanText(left);
  }

  return text;
}

function getRadioStationName(metadata = {}) {
  const candidates = [metadata.radioStationName, metadata.originalTitle, metadata.title, metadata.album];
  return firstText(...candidates.map((value) => cleanStationName(value)));
}

function stripRadioNoise(value) {
  return cleanText(value)
    .replace(/\s+\|\s+.*$/g, "")
    .replace(/\s+on\s+DI\.?FM.*$/i, "")
    .replace(/\s+-\s+DI\.?FM.*$/i, "")
    .replace(/\s+\([^)]*radio[^)]*\)\s*$/i, "")
    .trim();
}

function splitArtistTitle(value) {
  const text = stripRadioNoise(value);
  const separators = [" - ", " \u2013 ", " \u2014 "];

  for (const separator of separators) {
    if (!text.includes(separator)) continue;
    const [left, ...rest] = text.split(separator);
    const right = rest.join(separator);
    const a = cleanText(left);
    const b = cleanText(right);
    if (!a || !b || isStationText(b)) continue;
    if (isStationText(a)) {
      const nested = splitArtistTitle(b);
      return nested || { artist: "", title: b };
    }
    return { artist: a, title: b };
  }

  return null;
}

function parseRadioTrack(metadata = {}) {
  const title = stripRadioNoise(metadata.title);
  const artist = stripRadioNoise(metadata.artist);
  const album = stripRadioNoise(metadata.album);
  const titleLooksStation = isStationText(title);
  const artistLooksStation = isStationText(artist);

  const artistParsed = splitArtistTitle(artist);
  if (artistParsed && titleLooksStation) return artistParsed;

  const titleParsed = splitArtistTitle(title);
  if (titleParsed) {
    if (!titleParsed.artist && artist && !artistLooksStation) {
      return { artist, title: titleParsed.title };
    }
    return titleParsed;
  }

  for (const value of [artist, album]) {
    const parsed = splitArtistTitle(value);
    if (parsed) return parsed;
  }

  if (title && artist && !titleLooksStation && !artistLooksStation) {
    return { title, artist };
  }

  if (title && artist && titleLooksStation && !artistLooksStation) {
    return { artist: "", title: artist };
  }

  if (title && artist && !artistLooksStation) {
    return { title, artist };
  }

  return null;
}

function makeLookupKey(track) {
  return `${normalizeKeyPart(track.artist)}|${normalizeKeyPart(track.title)}`;
}

async function defaultFetchJson(url, { headers = {} } = {}) {
  if (typeof fetch !== "function") throw new Error("global fetch is not available");

  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...headers
    }
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function chooseRelease(recording) {
  const releases = Array.isArray(recording?.releases) ? recording.releases : [];
  return releases.find((release) => release?.id && release?.["release-group"]?.id) ||
    releases.find((release) => release?.id) ||
    null;
}

function chooseCoverImage(coverJson) {
  const images = Array.isArray(coverJson?.images) ? coverJson.images : [];
  const front = images.find((image) => image?.front) || images[0];
  if (!front) return "";

  return cleanText(
    front.thumbnails?.["500"] ||
      front.thumbnails?.large ||
      front.thumbnails?.["250"] ||
      front.thumbnails?.small ||
      front.image
  );
}
function isUsableDiscogsImage(value) {
  const url = cleanText(value);
  return !!url && !/spacer\.gif/i.test(url);
}

function normalizeDiscogsMatchText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isDiscogsTrackMatch(result, track = {}) {
  const resultTitle = normalizeDiscogsMatchText(result?.title);
  const trackTitle = normalizeDiscogsMatchText(track.title);
  const trackArtist = normalizeDiscogsMatchText(track.artist);

  if (!resultTitle) return false;
  if (trackTitle && !resultTitle.includes(trackTitle)) return false;
  if (trackArtist && !resultTitle.includes(trackArtist)) return false;
  return true;
}

function chooseDiscogsResult(searchJson, track = {}) {
  const results = Array.isArray(searchJson?.results) ? searchJson.results : [];
  const usableResults = results.filter((entry) => isUsableDiscogsImage(entry?.cover_image));
  const result = usableResults.find((entry) => isDiscogsTrackMatch(entry, track)) ||
    (!track.title && !track.artist ? usableResults[0] : null);
  if (!result) return null;

  return {
    title: cleanText(result.title),
    coverImage: cleanText(result.cover_image)
  };
}
function tidalCoverUrlFromUuid(uuid, size = 640) {
  const cleanUuid = cleanText(uuid);
  if (!cleanUuid) return "";
  return `https://resources.tidal.com/images/${cleanUuid.replace(/-/g, "/")}/${size}x${size}.jpg`;
}

function getTidalArtistNames(item = {}) {
  const artists = Array.isArray(item.artists) ? item.artists : [];
  return artists.map((artist) => cleanText(artist?.name)).filter(Boolean);
}

function getTidalItems(searchJson) {
  if (Array.isArray(searchJson?.items)) return searchJson.items;
  if (Array.isArray(searchJson?.tracks?.items)) return searchJson.tracks.items;
  if (Array.isArray(searchJson?.data)) return searchJson.data;
  return [];
}

function isTidalTrackMatch(item = {}, track = {}) {
  const resultTitle = normalizeDiscogsMatchText(item.title || item.attributes?.title);
  const trackTitle = normalizeDiscogsMatchText(track.title);
  const trackArtist = normalizeDiscogsMatchText(track.artist);
  const artistNames = getTidalArtistNames(item).join(" ") || cleanText(item.artist?.name || item.attributes?.artistName);
  const resultArtist = normalizeDiscogsMatchText(artistNames);

  if (!resultTitle || !trackTitle) return false;
  if (resultTitle !== trackTitle && !resultTitle.includes(trackTitle) && !trackTitle.includes(resultTitle)) return false;
  if (trackArtist && resultArtist && !resultArtist.includes(trackArtist) && !trackArtist.includes(resultArtist)) return false;
  return true;
}

function chooseTidalTrack(searchJson, track = {}) {
  const items = getTidalItems(searchJson);
  const result = items.find((entry) => isTidalTrackMatch(entry, track));
  if (!result) return null;

  const album = result.album || result.relationships?.albums?.data?.[0] || {};
  const coverUuid = cleanText(album.cover || album.attributes?.cover || result.cover || result.attributes?.cover);
  const coverImage = tidalCoverUrlFromUuid(coverUuid);
  if (!coverImage) return null;

  return {
    title: cleanText(result.title || result.attributes?.title),
    album: cleanText(album.title || album.attributes?.title),
    coverImage
  };
}


class RadioMetadataResolver extends EventEmitter {
  constructor({
    enabled = true,
    cacheMax = DEFAULT_CACHE_MAX,
    minLookupIntervalMs = DEFAULT_MIN_LOOKUP_INTERVAL_MS,
    logger,
    tidalArtworkEnabled = true,
    tidalCountryCode = "US",
    tidalAccessToken = "",
    discogsEnabled = true,
    discogsToken = "",
    fetchJson = defaultFetchJson,
    clock = () => Date.now()
  } = {}) {
    super();
    this.enabled = !!enabled;
    this.cacheMax = Number(cacheMax) || DEFAULT_CACHE_MAX;
    this.minLookupIntervalMs = Number(minLookupIntervalMs) || DEFAULT_MIN_LOOKUP_INTERVAL_MS;
    this.logger = logger;
    this.tidalArtworkEnabled = !!tidalArtworkEnabled;
    this.tidalCountryCode = cleanText(tidalCountryCode || "US") || "US";
    this.tidalAccessToken = cleanText(tidalAccessToken);
    this.discogsEnabled = !!discogsEnabled;
    this.discogsToken = cleanText(discogsToken);
    this.fetchJson = fetchJson;
    this.clock = clock;
    this.cache = new Map();
    this.pending = new Set();
    this.queue = [];
    this.inFlight = false;
    this.lastLookupAt = 0;
    this.timer = null;
  }

  apply(presence) {
    if (!this.enabled || presence?.timestampMode !== "RADIO") return false;

    const stationName = getRadioStationName(presence.metadata);
    if (stationName) presence.metadata.radioStationName = stationName;

    const track = parseRadioTrack(presence.metadata);
    if (!track) return false;

    const key = makeLookupKey(track);
    presence.metadata.radioTrackKey = key;
    presence.metadata.radioArtworkResolved = false;
    this.applyParsedTrack(presence, track);

    const cached = this.cache.get(key);
    if (cached?.status === "found") {
      this.applyResolvedMetadata(presence, cached.value);
      return true;
    }
    if (cached?.status === "missing") return false;

    this.enqueue(key, track);
    return false;
  }

  applyParsedTrack(presence, track) {
    if (track.title) presence.metadata.title = track.title;
    presence.metadata.artist = track.artist || "";

    if (presence.metadata.signalPath || !presence.activity) return;

    if (track.title) presence.activity.details = track.title.slice(0, 128);
    presence.activity.state = (track.artist || presence.metadata.radioStationName || "").slice(0, 128);
  }

  applyResolvedMetadata(presence, value) {
    if (!value?.albumArtUrl) return;

    presence.metadata.albumArtUrl = value.albumArtUrl;
    presence.metadata.albumArtKey = `radio:${value.key}`;
    presence.metadata.radioArtworkResolved = true;
    if (value.album) presence.metadata.album = value.album;
  }

  enqueue(key, track) {
    if (this.pending.has(key)) return;

    this.pending.add(key);
    this.queue.push({ key, track });
    this.schedule();
  }

  schedule() {
    if (this.timer || this.inFlight) return;

    const waitMs = Math.max(0, this.minLookupIntervalMs - (this.clock() - this.lastLookupAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.processNext();
    }, waitMs);
  }

  async processNext() {
    if (this.inFlight || !this.queue.length) return;

    const item = this.queue.shift();
    this.inFlight = true;
    try {
      const value = await this.lookup(item.track, item.key);
      this.remember(item.key, value ? { status: "found", value } : { status: "missing" });
      if (value) {
        const label = item.track.artist ? `${item.track.artist} - ${item.track.title}` : item.track.title;
        this.logger?.info?.(`Resolved radio metadata: ${label}`);
        this.emit("metadataResolved", value);
      }
    } catch (error) {
      this.logger?.debug?.("Radio metadata lookup failed", { error: error.message });
      this.remember(item.key, { status: "missing" });
    } finally {
      this.pending.delete(item.key);
      this.lastLookupAt = this.clock();
      this.inFlight = false;
      if (this.queue.length) this.schedule();
    }
  }

  async lookup(track, key) {
    const tidal = await this.lookupTidal(track, key);
    if (tidal) return tidal;

    const discogs = await this.lookupDiscogs(track, key);
    if (discogs) return discogs;

    const recordings = await this.searchRecordings(track);

    for (const recording of recordings) {
      const release = chooseRelease(recording);
      if (!release) continue;

      const groupId = release["release-group"]?.id;
      const coverUrl = groupId
        ? `https://coverartarchive.org/release-group/${groupId}`
        : `https://coverartarchive.org/release/${release.id}`;
      const coverJson = await this.fetchJson(coverUrl);
      const albumArtUrl = chooseCoverImage(coverJson);
      if (!albumArtUrl) continue;

      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(release.title || recording.title),
        albumArtUrl
      };
    }

    return null;
  }

  async lookupTidal(track, key) {
    if (!this.tidalArtworkEnabled) return null;

    try {
      return await this.searchTidal(track, key);
    } catch (error) {
      this.logger?.debug?.("TIDAL artwork lookup failed", { error: error.message });
      return null;
    }
  }

  async searchTidal(track, key) {
    const searches = [];
    if (track.artist) searches.push(`${track.artist} ${track.title}`);
    searches.push(track.title);

    for (const query of searches) {
      const searchUrl = new URL("https://api.tidal.com/v1/search/tracks");
      searchUrl.searchParams.set("query", query);
      searchUrl.searchParams.set("countryCode", this.tidalCountryCode);
      searchUrl.searchParams.set("limit", "5");

      const headers = {};
      if (this.tidalAccessToken) headers.authorization = `Bearer ${this.tidalAccessToken}`;

      const searchJson = await this.fetchJson(searchUrl.toString(), { headers });
      const result = chooseTidalTrack(searchJson, track);
      if (!result) continue;

      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.album || result.title),
        albumArtUrl: result.coverImage,
        source: "tidal"
      };
    }

    return null;
  }
  async lookupDiscogs(track, key) {
    if (!this.discogsEnabled || !this.discogsToken) return null;

    try {
      return await this.searchDiscogs(track, key);
    } catch (error) {
      this.logger?.debug?.("Discogs lookup failed", { error: error.message });
      return null;
    }
  }

  async searchDiscogs(track, key) {
    const searches = [];
    if (track.artist) {
      searches.push({ artist: track.artist, track: track.title });
      searches.push({ q: `${track.artist} ${track.title}` });
    }
    searches.push({ q: track.title });

    for (const params of searches) {
      const searchUrl = new URL("https://api.discogs.com/database/search");
      searchUrl.searchParams.set("type", "release");
      searchUrl.searchParams.set("per_page", "5");
      for (const [name, value] of Object.entries(params)) {
        if (value) searchUrl.searchParams.set(name, value);
      }

      const searchJson = await this.fetchJson(searchUrl.toString(), {
        headers: {
          authorization: `Discogs token=${this.discogsToken}`
        }
      });
      const result = chooseDiscogsResult(searchJson, track);
      if (!result) continue;

      return {
        key,
        title: track.title,
        artist: track.artist,
        album: cleanText(result.title),
        albumArtUrl: result.coverImage,
        source: "discogs"
      };
    }

    return null;
  }

  async searchRecordings(track) {
    const queries = [];
    if (track.artist) {
      queries.push(`recording:"${track.title}" AND artist:"${track.artist}"`);
    }
    queries.push(`recording:"${track.title}"`);

    for (const query of queries) {
      const searchUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5&inc=releases+artist-credits`;
      const searchJson = await this.fetchJson(searchUrl);
      const recordings = Array.isArray(searchJson?.recordings) ? searchJson.recordings : [];
      if (recordings.length) return recordings;
    }

    return [];
  }

  remember(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);

    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  updateConfig({ enabled, cacheMax, minLookupIntervalMs, tidalArtworkEnabled, tidalCountryCode, tidalAccessToken, discogsEnabled, discogsToken } = {}) {
    const nextEnabled = enabled !== undefined ? !!enabled : this.enabled;
    const nextCacheMax = Number(cacheMax) || this.cacheMax;
    const nextMinLookupIntervalMs = Number(minLookupIntervalMs) || this.minLookupIntervalMs;
    const nextTidalArtworkEnabled = tidalArtworkEnabled !== undefined ? !!tidalArtworkEnabled : this.tidalArtworkEnabled;
    const nextTidalCountryCode = tidalCountryCode !== undefined ? cleanText(tidalCountryCode || "US") || "US" : this.tidalCountryCode;
    const nextTidalAccessToken = tidalAccessToken !== undefined ? cleanText(tidalAccessToken) : this.tidalAccessToken;
    const nextDiscogsEnabled = discogsEnabled !== undefined ? !!discogsEnabled : this.discogsEnabled;
    const nextDiscogsToken = discogsToken !== undefined ? cleanText(discogsToken) : this.discogsToken;
    const changed =
      nextEnabled !== this.enabled ||
      nextCacheMax !== this.cacheMax ||
      nextMinLookupIntervalMs !== this.minLookupIntervalMs ||
      nextTidalArtworkEnabled !== this.tidalArtworkEnabled ||
      nextTidalCountryCode !== this.tidalCountryCode ||
      nextTidalAccessToken !== this.tidalAccessToken ||
      nextDiscogsEnabled !== this.discogsEnabled ||
      nextDiscogsToken !== this.discogsToken;

    if (!changed) return false;

    this.enabled = nextEnabled;
    this.cacheMax = nextCacheMax;
    this.minLookupIntervalMs = nextMinLookupIntervalMs;
    this.tidalArtworkEnabled = nextTidalArtworkEnabled;
    this.tidalCountryCode = nextTidalCountryCode;
    this.tidalAccessToken = nextTidalAccessToken;
    this.discogsEnabled = nextDiscogsEnabled;
    this.discogsToken = nextDiscogsToken;
    this.cache.clear();
    return true;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.pending.clear();
  }
}

module.exports = {
  RadioMetadataResolver,
  parseRadioTrack,
  makeLookupKey,
  chooseCoverImage,
  chooseRelease,
  chooseDiscogsResult,
  chooseTidalTrack,
  tidalCoverUrlFromUuid,
  getRadioStationName
};

