const crypto = require("crypto");
const http = require("http");
const https = require("https");

const DEFAULT_ALBUM_ART_PROXY_PORT = 8787;
const DEFAULT_ALBUM_ART_CACHE_MAX = 40;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function isUsablePublicBaseUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function fetchBuffer(url, timeoutMs = 10_000, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http;
    const request = client.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location || redirectsRemaining <= 0) {
          reject(new Error(`Image request failed with HTTP ${response.statusCode}`));
          return;
        }

        const nextUrl = new URL(location, url).toString();
        fetchBuffer(nextUrl, timeoutMs, redirectsRemaining - 1).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Image request failed with HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Image request timed out"));
    });
    request.on("error", reject);
  });
}

class AlbumArtProxy {
  constructor({
    publicBaseUrl = "",
    port = DEFAULT_ALBUM_ART_PROXY_PORT,
    cacheMax = DEFAULT_ALBUM_ART_CACHE_MAX,
    logger,
    fetchImage = fetchBuffer
  } = {}) {
    this.publicBaseUrl = trimTrailingSlash(publicBaseUrl);
    this.port = Number(port) || DEFAULT_ALBUM_ART_PROXY_PORT;
    this.cacheMax = Number(cacheMax) || DEFAULT_ALBUM_ART_CACHE_MAX;
    this.logger = logger;
    this.fetchImage = fetchImage;
    this.server = null;
    this.entries = new Map();
  }

  get enabled() {
    return isUsablePublicBaseUrl(this.publicBaseUrl);
  }

  start() {
    if (!this.enabled || this.server) return false;

    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        this.logger?.warn?.("Album art proxy request failed", { error: error.message });
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain" });
        }
        response.end("album art unavailable");
      });
    });

    this.server.listen(this.port, "0.0.0.0", () => {
      this.logger?.info?.(`Album art proxy listening on port ${this.port}`);
    });
    return true;
  }

  warnIfDisabled() {
    if (this.enabled) return;
    this.logger?.info?.(
      "Album art proxy is disabled. Set ALBUM_ART_PUBLIC_BASE_URL to a public HTTPS URL to show Roon album art in Discord."
    );
  }

  updateConfig({ publicBaseUrl, port, cacheMax } = {}) {
    const nextPublicBaseUrl = trimTrailingSlash(publicBaseUrl);
    const nextPort = Number(port) || DEFAULT_ALBUM_ART_PROXY_PORT;
    const nextCacheMax = Number(cacheMax) || DEFAULT_ALBUM_ART_CACHE_MAX;
    const changed =
      nextPublicBaseUrl !== this.publicBaseUrl ||
      nextPort !== this.port ||
      nextCacheMax !== this.cacheMax;

    if (!changed) return false;

    const wasRunning = !!this.server;
    this.stop();
    this.publicBaseUrl = nextPublicBaseUrl;
    this.port = nextPort;
    this.cacheMax = nextCacheMax;
    this.entries.clear();

    if (this.enabled) {
      this.start();
    } else if (wasRunning) {
      this.warnIfDisabled();
    }

    return true;
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  getPublicUrl(sourceUrl, imageKey = "") {
    if (!this.enabled || !sourceUrl) return "";

    const id = crypto
      .createHash("sha1")
      .update(`${imageKey}\n${sourceUrl}`)
      .digest("hex");
    this.remember(id, sourceUrl);
    return `${this.publicBaseUrl}/art/${id}.jpg`;
  }

  remember(id, sourceUrl) {
    const existing = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, existing || { sourceUrl, buffer: null, fetchedAt: 0 });

    while (this.entries.size > this.cacheMax) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  async handleRequest(request, response) {
    const match = /^\/art\/([a-f0-9]{40})\.jpg$/i.exec(request.url || "");
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    const entry = this.entries.get(match[1]);
    if (!entry) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    if (!entry.buffer) {
      entry.buffer = await this.fetchImage(entry.sourceUrl);
      entry.fetchedAt = Date.now();
    }

    response.writeHead(200, {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=3600",
      "content-length": entry.buffer.length
    });
    response.end(entry.buffer);
  }
}

module.exports = {
  AlbumArtProxy,
  DEFAULT_ALBUM_ART_PROXY_PORT,
  DEFAULT_ALBUM_ART_CACHE_MAX,
  isUsablePublicBaseUrl,
  fetchBuffer
};

