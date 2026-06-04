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
  return /\b(?:di\.?fm|radio|house|trance|progressive|channel|station|live|insomniac|mpact|impact|bangers)\b|\|/i.test(cleanText(value));
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
  const separators = [" - ", " – ", " — "];

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

  for (const value of [title, artist, album]) {
    const parsed = splitArtistTitle(value);
    if (parsed) return parsed;
  }

  if (title && artist && !isStationText(title) && !isStationText(artist)) {
    return { title, artist };
  }

  if (title && artist && !isStationText(artist)) {
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

class RadioMetadataResolver extends EventEmitter {
  constructor({
    enabled = true,
    cacheMax = DEFAULT_CACHE_MAX,
    minLookupIntervalMs = DEFAULT_MIN_LOOKUP_INTERVAL_MS,
    logger,
    fetchJson = defaultFetchJson,
    clock = () => Date.now()
  } = {}) {
    super();
    this.enabled = !!enabled;
    this.cacheMax = Number(cacheMax) || DEFAULT_CACHE_MAX;
    this.minLookupIntervalMs = Number(minLookupIntervalMs) || DEFAULT_MIN_LOOKUP_INTERVAL_MS;
    this.logger = logger;
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

    const track = parseRadioTrack(presence.metadata);
    if (!track) return false;

    const key = makeLookupKey(track);
    const cached = this.cache.get(key);
    if (cached?.status === "found") {
      this.applyResolvedMetadata(presence, cached.value);
      return true;
    }
    if (cached?.status === "missing") return false;

    this.enqueue(key, track);
    return false;
  }

  applyResolvedMetadata(presence, value) {
    if (!value?.albumArtUrl) return;

    presence.metadata.albumArtUrl = value.albumArtUrl;
    presence.metadata.albumArtKey = `radio:${value.key}`;
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

  updateConfig({ enabled, cacheMax, minLookupIntervalMs } = {}) {
    const nextEnabled = enabled !== undefined ? !!enabled : this.enabled;
    const nextCacheMax = Number(cacheMax) || this.cacheMax;
    const nextMinLookupIntervalMs = Number(minLookupIntervalMs) || this.minLookupIntervalMs;
    const changed =
      nextEnabled !== this.enabled ||
      nextCacheMax !== this.cacheMax ||
      nextMinLookupIntervalMs !== this.minLookupIntervalMs;

    if (!changed) return false;

    this.enabled = nextEnabled;
    this.cacheMax = nextCacheMax;
    this.minLookupIntervalMs = nextMinLookupIntervalMs;
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
  chooseRelease
};

