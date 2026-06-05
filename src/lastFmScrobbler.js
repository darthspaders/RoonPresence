const crypto = require("crypto");

const LASTFM_API_ROOT = "https://ws.audioscrobbler.com/2.0/";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeKeyPart(value) {
  return cleanText(value).toLowerCase();
}

function makeScrobbleKey({ artist, title }) {
  return `${normalizeKeyPart(artist)}|${normalizeKeyPart(title)}`;
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
    clock = () => Date.now()
  } = {}) {
    this.enabled = !!enabled;
    this.apiKey = cleanText(apiKey);
    this.apiSecret = cleanText(apiSecret);
    this.sessionKey = cleanText(sessionKey);
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.scrobbledKeys = new Set();
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
    if (this.scrobbledKeys.has(key)) return false;

    this.scrobbledKeys.add(key);
    const unixTimestamp = Math.max(1, Math.floor(this.clock() / 1000));
    this.logger?.info?.(`Scrobbling radio track to Last.fm: ${track.artist} - ${track.title}`);

    this.scrobble(track, unixTimestamp).catch((error) => {
      this.logger?.warn?.("Last.fm radio scrobble failed", { error: error.message });
    });
    return true;
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

  updateConfig({ enabled, apiKey, apiSecret, sessionKey } = {}) {
    const nextEnabled = enabled !== undefined ? !!enabled : this.enabled;
    const nextApiKey = apiKey !== undefined ? cleanText(apiKey) : this.apiKey;
    const nextApiSecret = apiSecret !== undefined ? cleanText(apiSecret) : this.apiSecret;
    const nextSessionKey = sessionKey !== undefined ? cleanText(sessionKey) : this.sessionKey;
    const changed =
      nextEnabled !== this.enabled ||
      nextApiKey !== this.apiKey ||
      nextApiSecret !== this.apiSecret ||
      nextSessionKey !== this.sessionKey;

    if (!changed) return false;

    this.enabled = nextEnabled;
    this.apiKey = nextApiKey;
    this.apiSecret = nextApiSecret;
    this.sessionKey = nextSessionKey;
    this.scrobbledKeys.clear();
    return true;
  }
}

module.exports = {
  LastFmScrobbler,
  createApiSignature,
  hasFullRadioTrack,
  makeScrobbleKey
};



