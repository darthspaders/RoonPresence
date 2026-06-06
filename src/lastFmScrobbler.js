const crypto = require("crypto");
const fs = require("fs");

const LASTFM_API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const DEFAULT_SCROBBLE_COOLDOWN_MS = 15 * 60 * 1000;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeKeyPart(value) {
  return cleanText(value).toLowerCase();
}

function makeScrobbleKey({ artist, title }) {
  return `${normalizeKeyPart(artist)}|${normalizeKeyPart(title)}`;
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch {
    // Cache persistence is best-effort; scrobbling should keep working without it.
  }
}

function readDurationMs(presence) {
  const candidates = [
    presence?.metadata?.trackDurationMs,
    presence?.metadata?.durationMs,
    presence?.metadata?.trackDurationSeconds !== undefined
      ? Number(presence.metadata.trackDurationSeconds) * 1000
      : null
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

function hasFullRadioTrack(presence) {
  if (presence?.timestampMode !== "RADIO") return false;

  const artist = cleanText(presence.metadata?.artist);
  const title = cleanText(presence.metadata?.title);
  if (!artist || !title) return false;

  const key = cleanText(presence.metadata?.radioTrackKey);
  if (!key || key.startsWith("|")) return false;

  return true;
}

function createApiSignature(params, secret) {
  const payload = Object.keys(params)
    .filter((key) => key !== "format" && key !== "callback" && key !== "api_sig")
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("") + secret;

  return crypto.createHash("md5").update(payload, "utf8").digest("hex");
}

class LastFmScrobbler {
  constructor({
    enabled = false,
    apiKey = "",
    apiSecret = "",
    sessionKey = "",
    logger,
    fetchImpl = globalThis.fetch,
    clock = () => Date.now(),
    scrobbleCooldownMs = DEFAULT_SCROBBLE_COOLDOWN_MS,
    scrobbleCachePath = ""
  } = {}) {
    this.enabled = !!enabled;
    this.apiKey = cleanText(apiKey);
    this.apiSecret = cleanText(apiSecret);
    this.sessionKey = cleanText(sessionKey);
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.scrobbleCooldownMs = Number(scrobbleCooldownMs) || DEFAULT_SCROBBLE_COOLDOWN_MS;
    this.scrobbleCachePath = cleanText(scrobbleCachePath);
    this.scrobbledAtByKey = new Map();
    this.loadScrobbleCache();
  }

  get configured() {
    return !!(this.enabled && this.apiKey && this.apiSecret && this.sessionKey);
  }

  maybeScrobble(presence) {
    if (!this.configured || !hasFullRadioTrack(presence)) return false;

    const track = {
      artist: cleanText(presence.metadata.artist),
      title: cleanText(presence.metadata.title),
      album: presence.metadata.radioArtworkResolved ? cleanText(presence.metadata.album) : ""
    };
    const key = cleanText(presence.metadata.radioTrackKey) || makeScrobbleKey(track);
    const now = this.clock();
    if (this.wasRecentlyScrobbled(key, now)) {
      this.logger?.info?.(`Last.fm radio scrobble skipped; recently scrobbled: ${track.artist} - ${track.title}`);
      return false;
    }

    this.markScrobbled(key, now);
    const unixTimestamp = Math.max(1, Math.floor(now / 1000));
    this.logger?.info?.(`Scrobbling radio track to Last.fm: ${track.artist} - ${track.title}`);

    this.scrobble(track, unixTimestamp).catch((error) => {
      this.logger?.warn?.("Last.fm radio scrobble failed", { error: error.message });
    });
    return true;
  }

  flush() {
    return false;
  }

  wasRecentlyScrobbled(key, now = this.clock()) {
    const lastAt = Number(this.scrobbledAtByKey.get(key));
    return Number.isFinite(lastAt) && now - lastAt >= 0 && now - lastAt < this.scrobbleCooldownMs;
  }

  markScrobbled(key, now = this.clock()) {
    this.scrobbledAtByKey.set(key, now);
    this.pruneScrobbleCache(now);
    this.saveScrobbleCache();
  }

  pruneScrobbleCache(now = this.clock()) {
    const maxAge = Math.max(this.scrobbleCooldownMs, DEFAULT_SCROBBLE_COOLDOWN_MS);
    for (const [key, timestamp] of this.scrobbledAtByKey) {
      if (!Number.isFinite(Number(timestamp)) || now - Number(timestamp) > maxAge) {
        this.scrobbledAtByKey.delete(key);
      }
    }
  }

  loadScrobbleCache() {
    const json = readJsonFile(this.scrobbleCachePath);
    const entries = json?.scrobbledAtByKey && typeof json.scrobbledAtByKey === "object" ? json.scrobbledAtByKey : {};
    this.scrobbledAtByKey.clear();
    for (const [key, timestamp] of Object.entries(entries)) {
      const value = Number(timestamp);
      if (key && Number.isFinite(value)) this.scrobbledAtByKey.set(key, value);
    }
    this.pruneScrobbleCache();
  }

  saveScrobbleCache() {
    writeJsonFile(this.scrobbleCachePath, {
      version: 1,
      scrobbledAtByKey: Object.fromEntries(this.scrobbledAtByKey)
    });
  }

  async scrobble(track, timestamp) {
    if (typeof this.fetchImpl !== "function") throw new Error("fetch is not available");

    const params = {
      method: "track.scrobble",
      api_key: this.apiKey,
      sk: this.sessionKey,
      artist: track.artist,
      track: track.title,
      timestamp: String(timestamp),
      chosenByUser: "0",
      format: "json"
    };
    if (track.album) params.album = track.album;
    params.api_sig = createApiSignature(params, this.apiSecret);

    const body = new URLSearchParams(params);
    const response = await this.fetchImpl(LASTFM_API_ROOT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    let json;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || json?.error) {
      const lastFmMessage = json?.message ? `${json.error || response.status}: ${json.message}` : `HTTP ${response.status}`;
      throw new Error(lastFmMessage);
    }

    const accepted = Number(json?.scrobbles?.["@attr"]?.accepted ?? 0);
    const ignored = Number(json?.scrobbles?.["@attr"]?.ignored ?? 0);
    this.logger?.info?.(`Scrobbled radio track to Last.fm: ${track.artist} - ${track.title}`, {
      accepted,
      ignored
    });
    return json;
  }

  updateConfig({ enabled, apiKey, apiSecret, sessionKey, scrobbleCooldownMs, scrobbleCachePath } = {}) {
    const nextEnabled = enabled !== undefined ? !!enabled : this.enabled;
    const nextApiKey = apiKey !== undefined ? cleanText(apiKey) : this.apiKey;
    const nextApiSecret = apiSecret !== undefined ? cleanText(apiSecret) : this.apiSecret;
    const nextSessionKey = sessionKey !== undefined ? cleanText(sessionKey) : this.sessionKey;
    const nextScrobbleCooldownMs = scrobbleCooldownMs !== undefined ? Number(scrobbleCooldownMs) || DEFAULT_SCROBBLE_COOLDOWN_MS : this.scrobbleCooldownMs;
    const nextScrobbleCachePath = scrobbleCachePath !== undefined ? cleanText(scrobbleCachePath) : this.scrobbleCachePath;
    const changed =
      nextEnabled !== this.enabled ||
      nextApiKey !== this.apiKey ||
      nextApiSecret !== this.apiSecret ||
      nextSessionKey !== this.sessionKey ||
      nextScrobbleCooldownMs !== this.scrobbleCooldownMs ||
      nextScrobbleCachePath !== this.scrobbleCachePath;

    if (!changed) return false;

    this.enabled = nextEnabled;
    this.apiKey = nextApiKey;
    this.apiSecret = nextApiSecret;
    this.sessionKey = nextSessionKey;
    const cachePathChanged = nextScrobbleCachePath !== this.scrobbleCachePath;
    this.scrobbleCooldownMs = nextScrobbleCooldownMs;
    this.scrobbleCachePath = nextScrobbleCachePath;
    if (cachePathChanged) this.loadScrobbleCache();
    else this.pruneScrobbleCache();
    return true;
  }
}

module.exports = {
  LastFmScrobbler,
  createApiSignature,
  hasFullRadioTrack,
  makeScrobbleKey,
  readDurationMs
};
