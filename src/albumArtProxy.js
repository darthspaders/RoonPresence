const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { Readable } = require("stream");
const zlib = require("zlib");

const DEFAULT_ALBUM_ART_PROXY_PORT = 8787;
const DEFAULT_ALBUM_ART_CACHE_MAX = 40;
const DEFAULT_NOW_ART_PATH = "/assets/radio-fallback.png";
const ASSET_PATHS = {
  "/assets/tidal-logo.png": path.join(__dirname, "..", "assets", "tidal-logo.png"),
  "/assets/spotify-full-logo.png": path.join(__dirname, "..", "assets", "spotify-full-logo.png"),
  "/assets/apple-music-logo.png": path.join(__dirname, "..", "assets", "apple-music-logo.png"),
  [DEFAULT_NOW_ART_PATH]: path.join(__dirname, "..", "assets", "radio-fallback.png")
};
const DEFAULT_CACHE_DIR = path.join(__dirname, "..", ".cache");
const TIDAL_BRIDGE_CACHE_FILE = "tidal-bridge-cache.json";
const NOW_PLAYING_CACHE_FILE = "now-playing-cache.json";
const ART_CACHE_MANIFEST_FILE = "album-art-cache.json";
const ART_CACHE_DIR_NAME = "art";
const assetBuffers = new Map();
const DEFAULT_NOW_HISTORY_MAX = 25;
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const MCP_PROXY_MAX_BODY_BYTES = 5 * 1024 * 1024;
const MCP_PROXY_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id"
];
const MCP_PROXY_RESPONSE_HEADERS = [
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "cache-control",
  "content-type",
  "expires",
  "mcp-session-id",
  "pragma",
  "www-authenticate"
];
const RABBIT_HOLE_WEB_PROXY_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "expires",
  "location",
  "pragma"
];
const RABBIT_HOLE_TIDAL_OAUTH_PROXY_RE = /^\/api\/tidal\/oauth\/(?:start|callback)$/i;
let sharpModule;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cleanUserSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function cleanBrandName(value) {
  return cleanBridgeText(value, 80) || "RoonPresence";
}

function isUsablePublicBaseUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isPrivateHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  return private172;
}

function roonImageFallbackUrl(value = "") {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!isPrivateHost(url.hostname) || !/^\/api\/image\//i.test(url.pathname)) return "";
  const before = url.search;
  url.searchParams.delete("scale");
  url.searchParams.delete("format");
  return url.search !== before ? url.toString() : "";
}

function isAllowedBridgeArtworkSource(sourceUrl = "", publicBaseUrl = "") {
  if (!isHttpUrl(sourceUrl)) return false;
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }

  if (publicBaseUrl && sourceUrl.startsWith(`${trimTrailingSlash(publicBaseUrl)}/art/`)) {
    return /\/art\/[a-f0-9]{40}\.jpg$/i.test(parsed.pathname);
  }
  if (isPrivateHost(parsed.hostname)) return false;

  const host = parsed.hostname.toLowerCase();
  return host === "resources.tidal.com" ||
    host === "images.tidal.com" ||
    host === "coverartarchive.org" ||
    host.endsWith(".coverartarchive.org") ||
    host === "i.scdn.co" ||
    host === "mosaic.scdn.co" ||
    host.endsWith(".discogs.com") ||
    host.endsWith(".mzstatic.com") ||
    host === "lastfm.freetls.fastly.net" ||
    host.endsWith(".lastfm.freetls.fastly.net") ||
    host === "lastfm-img2.akamaized.net" ||
    host.endsWith(".lastfm-img2.akamaized.net");
}

function readRequestBody(request, maxBytes = 64 * 1024) {
  if (!request || typeof request.on !== "function") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...headers
  });
  response.end(text);
}

function mcpCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "mcp-session-id"
  };
}

function copyProxyRequestHeaders(headers = {}) {
  const copied = {};
  for (const name of MCP_PROXY_REQUEST_HEADERS) {
    const value = headers[name];
    if (value === undefined) continue;
    copied[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return copied;
}

function copyProxyResponseHeaders(headers) {
  const copied = {};
  for (const name of MCP_PROXY_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) copied[name] = value;
  }
  return {
    ...mcpCorsHeaders(),
    "cache-control": "no-store",
    ...copied
  };
}

function copyRabbitHoleWebResponseHeaders(headers) {
  const copied = {};
  for (const name of RABBIT_HOLE_WEB_PROXY_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) copied[name] = value;
  }
  return {
    "cache-control": "no-store",
    ...copied
  };
}

function forwardedRabbitHoleWebHeaders(requestHeaders = {}, publicBaseUrl = "") {
  const headers = {
    accept: Array.isArray(requestHeaders.accept) ? requestHeaders.accept.join(", ") : String(requestHeaders.accept || "text/html,application/xhtml+xml")
  };
  const host = Array.isArray(requestHeaders["x-forwarded-host"])
    ? requestHeaders["x-forwarded-host"][0]
    : (requestHeaders["x-forwarded-host"] || requestHeaders.host || "");
  if (host) headers["x-forwarded-host"] = String(host);

  const proto = Array.isArray(requestHeaders["x-forwarded-proto"])
    ? requestHeaders["x-forwarded-proto"][0]
    : requestHeaders["x-forwarded-proto"];
  if (proto) {
    headers["x-forwarded-proto"] = String(proto);
  } else if (publicBaseUrl) {
    try {
      headers["x-forwarded-proto"] = new URL(publicBaseUrl).protocol.replace(/:$/, "") || "https";
    } catch {
      headers["x-forwarded-proto"] = "https";
    }
  }

  return headers;
}

function getSharp() {
  if (sharpModule !== undefined) return sharpModule;
  try {
    sharpModule = require("sharp");
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

function cleanBridgeText(value, maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function createBridgeQuery({ albumArtUrl = "", title = "", artist = "" } = {}) {
  const params = new URLSearchParams();
  const cleanAlbumArtUrl = String(albumArtUrl || "").trim();
  const cleanTitle = cleanBridgeText(title);
  const cleanArtist = cleanBridgeText(artist);
  if (isHttpUrl(cleanAlbumArtUrl)) params.set("art", cleanAlbumArtUrl);
  if (cleanTitle) params.set("title", cleanTitle);
  if (cleanArtist) params.set("artist", cleanArtist);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function getTidalTrackId(value) {
  const match = String(value || "").match(/^https?:\/\/(?:www\.)?(?:listen\.)?tidal\.com\/(?:browse\/)?track\/(\d+)/i);
  return match ? match[1] : "";
}

function getTidalBridgeTrackId(value) {
  const match = String(value || "").match(/^https?:\/\/[^/]+\/tidal\/(?:track|manual|intent|app)\/(\d+)/i);
  return match ? match[1] : "";
}

function createTidalTrackUrl(trackId) {
  const id = String(trackId || "").replace(/\D/g, "");
  return id ? "https://tidal.com/browse/track/" + id : "";
}

function isTidalActivityButton(button) {
  const label = String(button?.label || "");
  const url = String(button?.url || "");
  if (!isHttpUrl(url)) return false;
  return /tidal/i.test(label) || Boolean(getTidalTrackId(url) || getTidalBridgeTrackId(url));
}

function createTidalAndroidIntent(trackId, fallbackUrl = "") {
  const fallback = fallbackUrl ? ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) : "";
  return "intent://track/" + trackId + "#Intent;scheme=tidal;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE" + fallback + ";end";
}

function createTidalAndroidWakeIntent(fallbackUrl = "") {
  const fallback = fallbackUrl ? ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) : "";
  return "intent://#Intent;scheme=tidal;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE" + fallback + ";end";
}

function createTidalHttpsAndroidIntent(trackId, fallbackUrl = "") {
  const fallback = fallbackUrl ? ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) : "";
  return "intent://tidal.com/browse/track/" + trackId + "#Intent;scheme=https;package=com.aspiro.tidal;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE" + fallback + ";end";
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value, maxChars, maxLines) {
  const words = cleanBridgeText(value, 240).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length ? lines : [""];
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createFallbackPng(width = OG_IMAGE_WIDTH, height = OG_IMAGE_HEIGHT) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const glow = Math.max(0, 1 - Math.hypot((x - width * 0.28) / width, (y - height * 0.28) / height) * 2.8);
      raw[offset] = Math.round(8 + glow * 54);
      raw[offset + 1] = Math.round(9 + glow * 36);
      raw[offset + 2] = Math.round(13 + glow * 72);
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function formatNowTime(value) {
  if (!Number.isFinite(value)) return "";
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function mergeNowHistoryItem(existing = {}, next = {}) {
  return {
    ...existing,
    ...next,
    albumArtUrl: next.albumArtUrl || existing.albumArtUrl || "",
    bridgeUrl: next.bridgeUrl || existing.bridgeUrl || "",
    tidalUrl: next.tidalUrl || existing.tidalUrl || "",
    radioStationName: next.radioStationName || existing.radioStationName || "",
    signalPath: next.signalPath || existing.signalPath || "",
    album: next.album || existing.album || ""
  };
}

function normalizeNowKey(title = "", artist = "") {
  return `${cleanBridgeText(artist).toLowerCase()}|${cleanBridgeText(title).toLowerCase()}`;
}

function getNowVersion(nowPlaying = null) {
  if (!nowPlaying) return "idle";
  return [
    normalizeNowKey(nowPlaying.title, nowPlaying.artist),
    cleanBridgeText(nowPlaying.albumArtUrl),
    cleanBridgeText(nowPlaying.bridgeUrl),
    cleanBridgeText(nowPlaying.signalPath || nowPlaying.radioStationName || nowPlaying.album)
  ].join("|");
}

function getNowPreviewVersion(nowPlaying = null) {
  if (!nowPlaying) return "idle";
  return crypto
    .createHash("sha1")
    .update(getNowVersion(nowPlaying))
    .digest("hex")
    .slice(0, 12);
}

function getAssetBuffer(assetPath) {
  if (!assetBuffers.has(assetPath)) {
    assetBuffers.set(assetPath, fs.readFileSync(assetPath));
  }
  return assetBuffers.get(assetPath);
}

function getAssetContentType(assetPath) {
  return /\.svg$/i.test(assetPath) ? "image/svg+xml" : "image/png";
}

function createMusicSearchQuery(title = "", artist = "") {
  return cleanBridgeText([title, artist].filter(Boolean).join(" "), 220);
}

function createSpotifySearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query ? "https://open.spotify.com/search/" + encodeURIComponent(query) : "https://open.spotify.com/search";
}

function createTidalSearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query ? "https://tidal.com/search?q=" + encodeURIComponent(query) : "https://tidal.com/search";
}

function createAppleMusicSearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query ? "https://music.apple.com/us/search?term=" + encodeURIComponent(query) : "https://music.apple.com/us/search";
}

function createAppleMusicWebSearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query
    ? "https://www.google.com/search?q=" + encodeURIComponent("site:music.apple.com " + query)
    : "https://www.google.com/search?q=" + encodeURIComponent("Apple Music");
}

function createSpotifyAndroidSearchIntent(query = "", fallbackUrl = "") {
  const cleanQuery = createMusicSearchQuery(query);
  const fallback = fallbackUrl ? ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) : "";
  return "intent://search/" + encodeURIComponent(cleanQuery) + "#Intent;scheme=spotify;package=com.spotify.music;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE" + fallback + ";end";
}

function createAppleMusicAndroidSearchIntent(query = "", fallbackUrl = "") {
  const cleanQuery = createMusicSearchQuery(query);
  const fallback = fallbackUrl ? ";S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) : "";
  return "intent://music.apple.com/us/search?term=" + encodeURIComponent(cleanQuery) + "#Intent;scheme=https;package=com.apple.android.music;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE" + fallback + ";end";
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readArtCacheManifest(filePath) {
  const raw = readJsonFile(filePath, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const manifest = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-f0-9]{40}$/i.test(id) || !value || typeof value !== "object") continue;
    const sourceUrl = isHttpUrl(value.sourceUrl) ? String(value.sourceUrl).trim() : "";
    if (!sourceUrl) continue;
    manifest[id] = {
      sourceUrl,
      fetchedAt: Number.isFinite(Number(value.fetchedAt)) ? Number(value.fetchedAt) : 0
    };
  }
  return manifest;
}

function normalizeNowItem(value = {}) {
  const title = cleanBridgeText(value.title);
  if (!title) return null;

  return {
    title,
    artist: cleanBridgeText(value.artist),
    album: cleanBridgeText(value.album),
    radioStationName: cleanBridgeText(value.radioStationName),
    signalPath: cleanBridgeText(value.signalPath),
    timestampMode: cleanBridgeText(value.timestampMode),
    albumArtUrl: isHttpUrl(value.albumArtUrl) ? String(value.albumArtUrl).trim() : "",
    tidalUrl: isHttpUrl(value.tidalUrl) ? String(value.tidalUrl).trim() : "",
    bridgeUrl: isHttpUrl(value.bridgeUrl) ? String(value.bridgeUrl).trim() : "",
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now()
  };
}

function normalizeNowCache(value = {}, historyMax = DEFAULT_NOW_HISTORY_MAX) {
  const nowPlaying = normalizeNowItem(value.nowPlaying || {});
  const history = Array.isArray(value.nowHistory)
    ? value.nowHistory.map(normalizeNowItem).filter(Boolean).slice(0, historyMax)
    : [];

  return { nowPlaying, nowHistory: history };
}

function getRequestPublicUrl(request, parsedUrl) {
  const host = request.headers?.["x-forwarded-host"] || request.headers?.host || "";
  if (!host) return "";
  const proto = request.headers?.["x-forwarded-proto"] || "https";
  return `${proto}://${host}${parsedUrl.pathname}${parsedUrl.search}`;
}

function tidalTrackHtml(trackId, albumArtUrl = "", { title = "", artist = "", pageUrl = "", shareUrl = "", brandName = "darthspader.com" } = {}) {
  const id = htmlEscape(trackId);
  const cleanAlbumArtUrl = isHttpUrl(albumArtUrl) ? String(albumArtUrl).trim() : "";
  const cleanTitle = cleanBridgeText(title);
  const cleanArtist = cleanBridgeText(artist);
  const webUrl = "https://tidal.com/browse/track/" + id;
  const androidHttpsIntent = createTidalHttpsAndroidIntent(id);
  const androidWakeIntent = createTidalAndroidWakeIntent();
  const otherAppUrl = "tidal://track/" + id;
  const artSrc = htmlEscape(cleanAlbumArtUrl);
  const backgroundHtml = cleanAlbumArtUrl ? "<img class=\"background-art\" src=\"" + artSrc + "\" alt=\"\">" : "";
  const coverHtml = cleanAlbumArtUrl ? "<img class=\"cover-art\" src=\"" + artSrc + "\" alt=\"Album art\">" : "";
  const coverSectionHtml = coverHtml
    ? "<a class=\"cover-wrap\" id=\"cover-link\" href=\"" + androidHttpsIntent + "\" aria-label=\"Play on TIDAL\">" + coverHtml + "</a>"
    : "";
  const titleHtml = htmlEscape(cleanTitle || "Ready in TIDAL");
  const titleClass = cleanTitle.length > 42 ? " class=\"long-title\"" : "";
  const artistHtml = cleanArtist ? "<p class=\"artist\">" + htmlEscape(cleanArtist) + "</p>" : "";
  const shellStyle = cleanAlbumArtUrl ? " style=\"--accent-art:url('" + htmlEscape(cleanAlbumArtUrl.replace(/'/g, "%27")) + "')\"" : "";
  const pageTitle = cleanTitle ? `${cleanTitle}${cleanArtist ? ` - ${cleanArtist}` : ""}` : "Play on TIDAL";
  const pageDescription = cleanArtist ? `Listen to ${cleanTitle} by ${cleanArtist} on TIDAL.` : "Open this track on TIDAL.";
  const metaImage = cleanAlbumArtUrl || "";
  const cleanShareUrl = shareUrl || pageUrl || webUrl;
  const metaUrl = pageUrl || cleanShareUrl;
  const metaHtml =
    "<link rel=\"canonical\" href=\"" + htmlEscape(cleanShareUrl) + "\">" +
    "<meta property=\"og:type\" content=\"music.song\">" +
    "<meta property=\"og:site_name\" content=\"" + htmlEscape(brandName) + "\">" +
    "<meta property=\"og:title\" content=\"" + htmlEscape(pageTitle) + "\">" +
    "<meta property=\"og:description\" content=\"" + htmlEscape(pageDescription) + "\">" +
    "<meta property=\"og:url\" content=\"" + htmlEscape(metaUrl) + "\">" +
    (metaImage ? "<meta property=\"og:image\" content=\"" + htmlEscape(metaImage) + "\">" : "") +
    "<meta name=\"twitter:card\" content=\"" + (metaImage ? "summary_large_image" : "summary") + "\">" +
    "<meta name=\"twitter:title\" content=\"" + htmlEscape(pageTitle) + "\">" +
    "<meta name=\"twitter:description\" content=\"" + htmlEscape(pageDescription) + "\">" +
    (metaImage ? "<meta name=\"twitter:image\" content=\"" + htmlEscape(metaImage) + "\">" : "");
  const brandHtml = "<header class=\"brand\"><div class=\"brand-word\">" + htmlEscape(brandName) + "</div></header>";
  const tidalLogoHtml = "<img class=\"tidal-logo\" src=\"/assets/tidal-logo.png\" alt=\"TIDAL\">";
  const musicSearchQuery = createMusicSearchQuery(cleanTitle, cleanArtist);
  const spotifySearchUrl = createSpotifySearchUrl(cleanTitle, cleanArtist);
  const appleMusicSearchUrl = createAppleMusicSearchUrl(cleanTitle, cleanArtist);
  const spotifyAppUrl = "spotify:search:" + encodeURIComponent(musicSearchQuery);
  const appleMusicAppUrl = "music://music.apple.com/us/search?term=" + encodeURIComponent(musicSearchQuery);
  const spotifyAndroidIntent = createSpotifyAndroidSearchIntent(musicSearchQuery, spotifySearchUrl);
  const appleMusicAndroidIntent = createAppleMusicAndroidSearchIntent(musicSearchQuery, appleMusicSearchUrl);
  const secondaryLinksHtml = cleanTitle || cleanArtist
      ? "<div class=\"music-links\">" +
      "<a class=\"music-link spotify-link\" id=\"spotify-search\" href=\"" + htmlEscape(spotifySearchUrl) + "\" target=\"_blank\" rel=\"noopener\" aria-label=\"Search on Spotify\">" +
      "<img class=\"spotify-logo\" src=\"/assets/spotify-full-logo.png\" alt=\"Spotify\">" +
      "</a>" +
      "<a class=\"music-link apple-link\" id=\"apple-search\" href=\"" + htmlEscape(appleMusicSearchUrl) + "\" target=\"_blank\" rel=\"noopener\" aria-label=\"Search on Apple Music\">" +
      "<img class=\"apple-logo\" src=\"/assets/apple-music-logo.png\" alt=\"Apple Music\">" +
      "</a>" +
      "</div>"
    : "";
  return "<!doctype html>" +
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + htmlEscape(pageTitle) + "</title>" + metaHtml + "<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#020202;color:#fff;display:grid;min-height:100vh;place-items:center;margin:0;padding:16px 24px 32px;overflow:hidden}body:before{content:\"\";position:fixed;inset:0;background:radial-gradient(circle at 50% 18%,rgba(0,255,255,.06),transparent 34%),rgba(0,0,0,.54);z-index:0}.background-art{position:fixed;inset:-36px;width:calc(100% + 72px);height:calc(100% + 72px);object-fit:cover;filter:blur(28px);opacity:.38;transform:scale(1.05);z-index:0}.shell{position:relative;z-index:1;isolation:isolate;width:min(92vw,430px);padding:22px 24px 24px;border:1px solid rgba(255,255,255,.11);border-radius:30px;background:linear-gradient(180deg,rgba(12,12,14,.72),rgba(4,4,5,.58));box-shadow:0 28px 100px rgba(0,0,0,.58),0 0 72px rgba(255,186,90,.10),inset 0 1px 0 rgba(255,255,255,.08);backdrop-filter:blur(18px);text-align:center;transform:translateY(-5vh)}.shell:before{content:\"\";position:absolute;inset:-22px;border-radius:38px;background:var(--accent-art);background-size:cover;background-position:center;filter:blur(36px);opacity:.20;z-index:-1;transform:scale(1.04)}.brand{margin:0 auto 14px;text-align:center}.brand-word{font-size:13px;font-weight:700;letter-spacing:.24em;background:linear-gradient(90deg,rgba(114,233,255,.72),rgba(243,137,255,.72));-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 16px rgba(134,217,255,.13)}.cover-wrap{position:relative;width:min(58vw,228px);height:min(58vw,228px);margin:0 auto 22px}.cover-wrap:before{content:\"\";position:absolute;inset:-24px;border-radius:38px;background:radial-gradient(circle,rgba(255,186,90,.34),rgba(0,255,255,.10) 42%,rgba(0,0,0,0) 72%);filter:blur(24px);opacity:.72}.cover-art{position:relative;width:100%;height:100%;object-fit:cover;border-radius:20px;display:block;box-shadow:0 24px 70px rgba(0,0,0,.55)}h1{width:min(100%,360px);margin:0 auto;text-align:center;text-wrap:balance;font-size:clamp(27px,6.8vw,38px);line-height:1.08;font-weight:850;letter-spacing:0}.long-title{font-size:clamp(24px,6.1vw,34px)}.artist{width:min(100%,340px);margin:10px auto 24px;text-align:center;color:rgba(255,255,255,.64);font-size:clamp(18px,4.8vw,22px);line-height:1.2}.tidal-button{display:flex;align-items:center;justify-content:center;gap:12px;margin:0;min-height:58px;padding:17px 18px;border-radius:16px;background:linear-gradient(180deg,#050505,#000);border:1px solid rgba(255,255,255,.16);color:#fff;text-decoration:none;font-weight:850;box-shadow:0 20px 54px rgba(0,0,0,.56),0 0 30px rgba(255,255,255,.08),0 0 42px rgba(255,186,90,.08),0 0 0 1px rgba(0,255,255,.08),inset 0 1px 0 rgba(255,255,255,.12)}.tidal-logo{width:118px;height:auto;display:block;filter:invert(1);opacity:.92}.tidal-button span{line-height:1}.music-links{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.music-link{display:flex;align-items:center;justify-content:center;min-height:42px;padding:10px 12px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(255,255,255,.055);color:#fff;text-decoration:none;font-size:13px;font-weight:800;box-shadow:inset 0 1px 0 rgba(255,255,255,.07)}.tidal-button,.music-link,.share-actions button{transition:transform .14s ease,box-shadow .14s ease,filter .14s ease}.tidal-button:hover,.music-link:hover,.share-actions button:hover{transform:translateY(-1px);filter:brightness(1.08)}.tidal-button:active,.music-link:active,.share-actions button:active{transform:scale(.985)}.spotify-link{background:linear-gradient(180deg,rgba(30,215,96,.28),rgba(30,215,96,.10)),rgba(255,255,255,.055);border-color:rgba(30,215,96,.34);box-shadow:0 0 24px rgba(30,215,96,.18),inset 0 1px 0 rgba(255,255,255,.09)}.spotify-logo{width:112px;max-width:100%;height:auto;display:block}.apple-link{position:relative;overflow:hidden;background:radial-gradient(circle at 24% 32%,rgba(255,255,255,.34),transparent 28%),linear-gradient(135deg,#87184e 0%,#e2145d 48%,#ff2f4f 100%);border-color:rgba(255,132,176,.44);box-shadow:0 0 26px rgba(255,47,104,.22),inset 0 1px 0 rgba(255,255,255,.18)}.apple-logo{width:122px;max-width:96%;height:auto;display:block;margin:0 auto;transform:translateX(1px);filter:drop-shadow(0 2px 8px rgba(255,255,255,.22)) drop-shadow(0 6px 14px rgba(0,0,0,.30))}.share-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.share-actions button{appearance:none;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.78);font:inherit;font-size:14px;font-weight:700;padding:11px 12px}</style></head>" +
    "<body>" + backgroundHtml + "<main class=\"shell\"" + shellStyle + ">" + brandHtml + coverSectionHtml + "<h1" + titleClass + ">" + titleHtml + "</h1>" + artistHtml +
    "<a class=\"tidal-button\" id=\"open-track\" href=\"" + androidHttpsIntent + "\"><span>Play on</span>" + tidalLogoHtml + "</a>" +
    secondaryLinksHtml + "<div class=\"share-actions\"><button id=\"share-track\" type=\"button\">Share Track</button><button id=\"copy-link\" type=\"button\">Copy link</button></div>" +
    "<script>(function(){var open=document.getElementById(\"open-track\");var cover=document.getElementById(\"cover-link\");var share=document.getElementById(\"share-track\");var copy=document.getElementById(\"copy-link\");var spotify=document.getElementById(\"spotify-search\");var apple=document.getElementById(\"apple-search\");var shareUrl=" + JSON.stringify(cleanShareUrl) + ";var androidIntent=" + JSON.stringify(androidHttpsIntent) + ";var androidWakeIntent=" + JSON.stringify(androidWakeIntent) + ";var appUrl=" + JSON.stringify(otherAppUrl) + ";var spotifyAndroidIntent=" + JSON.stringify(spotifyAndroidIntent) + ";var spotifyAppUrl=" + JSON.stringify(spotifyAppUrl) + ";var spotifyWebUrl=" + JSON.stringify(spotifySearchUrl) + ";var appleAppUrl=" + JSON.stringify(appleMusicAppUrl) + ";var appleWebUrl=" + JSON.stringify(appleMusicSearchUrl) + ";var isAndroid=/Android/i.test(navigator.userAgent||\"\");var isIos=/iPhone|iPad|iPod/i.test(navigator.userAgent||\"\");var waitingForWake=false;var sentAfterWake=false;function send(url){window.location.href=url;}function openTrack(){waitingForWake=false;sentAfterWake=false;send(isAndroid?androidIntent:appUrl);if(isAndroid){setTimeout(function(){if(document.visibilityState!==\"hidden\"){waitingForWake=true;send(androidWakeIntent);}},900);}}function handleOpen(event){event.preventDefault();openTrack();}function openMusicApp(event,androidUrl,iosUrl,webUrl){event.preventDefault();if(isAndroid){send(androidUrl);return;}if(isIos){send(iosUrl);setTimeout(function(){if(document.visibilityState!==\"hidden\"){send(webUrl);}},900);return;}window.open(webUrl,\"_blank\",\"noopener\");}function copyShare(){if(navigator.clipboard){navigator.clipboard.writeText(shareUrl);}}open.addEventListener(\"click\",handleOpen);if(cover){cover.addEventListener(\"click\",handleOpen);}if(spotify){spotify.addEventListener(\"click\",function(event){openMusicApp(event,spotifyAndroidIntent,spotifyAppUrl,spotifyWebUrl);});}if(apple){apple.addEventListener(\"click\",function(event){openMusicApp(event,appleWebUrl,appleAppUrl,appleWebUrl);});}if(share){share.addEventListener(\"click\",function(){if(navigator.share){navigator.share({title:" + JSON.stringify(pageTitle) + ",url:shareUrl}).catch(function(){});}else{copyShare();}});}if(copy){copy.addEventListener(\"click\",copyShare);}document.addEventListener(\"visibilitychange\",function(){if(isAndroid&&waitingForWake&&!sentAfterWake&&document.visibilityState===\"visible\"){sentAfterWake=true;waitingForWake=false;setTimeout(function(){send(androidIntent);},350);}});})();</script>" +
    "</main></body></html>";
}

function createNowDescription(nowPlaying = null, brandName = "RoonPresence") {
  const title = cleanBridgeText(nowPlaying?.title || "");
  const artist = cleanBridgeText(nowPlaying?.artist || "");
  if (title && artist) return `${title} — ${artist}`;
  if (title) return title;
  return "Live now playing from " + brandName;
}

async function createNowOgImage(nowPlaying = null, fetchImage = fetchBuffer, { brandName = "darthspader.com" } = {}) {
  const sharp = getSharp();
  if (!sharp) return createFallbackPng();

  const title = cleanBridgeText(nowPlaying?.title || "Nothing Playing", 110);
  const artist = cleanBridgeText(nowPlaying?.artist || "Darthspader", 90);
  const artUrl = isHttpUrl(nowPlaying?.albumArtUrl) ? nowPlaying.albumArtUrl : "";
  let artBuffer = getAssetBuffer(ASSET_PATHS[DEFAULT_NOW_ART_PATH]);
  if (artUrl) {
    try {
      artBuffer = await fetchImage(artUrl);
    } catch {
      artBuffer = getAssetBuffer(ASSET_PATHS[DEFAULT_NOW_ART_PATH]);
    }
  }
  const titleLines = wrapText(title, title.length > 36 ? 20 : 22, 3);
  const titleFontSize = titleLines.length > 2 ? 40 : title.length > 42 ? 44 : 50;
  const titleLineStep = titleLines.length > 2 ? 48 : 56;
  const titleStartY = titleLines.length > 2 ? 274 : 286;
  const artistY = titleStartY + titleLines.length * titleLineStep + 44;
  const titleSvg = titleLines.map((line, index) =>
    `<text x="520" y="${titleStartY + index * titleLineStep}" font-size="${titleFontSize}" font-weight="850" fill="#ffffff">${xmlEscape(line)}</text>`
  ).join("");
  const overlaySvg = Buffer.from(
    `<svg width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="rgba(0,0,0,0.46)"/>
      <rect x="70" y="70" width="1060" height="490" rx="42" fill="rgba(10,10,14,0.68)" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>
      <text x="520" y="186" font-size="28" font-weight="800" letter-spacing="5" fill="rgba(190,205,255,0.82)">${xmlEscape(brandName)}</text>
      <text x="520" y="230" font-size="28" font-weight="800" letter-spacing="4" fill="rgba(255,255,255,0.58)">NOW PLAYING</text>
      ${titleSvg}
      <text x="520" y="${artistY}" font-size="38" font-weight="600" fill="rgba(255,255,255,0.70)">${xmlEscape(artist)}</text>
    </svg>`
  );

  const background = await sharp(artBuffer).resize(OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, { fit: "cover" }).blur(26).modulate({ brightness: 0.74 }).png().toBuffer();
  const composites = [{ input: overlaySvg, top: 0, left: 0 }];

  const coverMask = Buffer.from(`<svg width="380" height="380"><rect width="380" height="380" rx="34" fill="#fff"/></svg>`);
  const cover = await sharp(artBuffer)
    .resize(380, 380, { fit: "cover" })
    .composite([{ input: coverMask, blend: "dest-in" }])
    .png()
    .toBuffer();
  composites.push({ input: cover, top: 125, left: 105 });

  return sharp(background).composite(composites).png().toBuffer();
}

// Runs in the public Now Playing page; text stays in the accessible DOM.
function installNowPlayingScroll() {
  const motion=matchMedia("(prefers-reduced-motion: reduce)");
  const labels=[...document.querySelectorAll(".card h1, .card .artist")].map(element=>{
    const text=document.createElement("span");text.textContent=element.textContent;
    element.replaceChildren(text);element.classList.add("scrolling-label");element.title=text.textContent;
    const item={element,text,key:"",animation:null};
    const pause=()=>item.animation?.pause();
    const resume=()=>{if(!element.matches(":hover, :focus-within"))item.animation?.play();};
    element.addEventListener("mouseenter",pause);element.addEventListener("mouseleave",resume);
    element.addEventListener("focusin",pause);element.addEventListener("focusout",resume);
    return item;
  });
  function measure(){
    for(const item of labels){
      const {element,text}=item,distance=Math.max(0,text.scrollWidth-element.clientWidth);
      const key=[element.clientWidth,distance,motion.matches].join("|");
      if(key===item.key)continue;item.key=key;item.animation?.cancel();item.animation=null;
      element.classList.toggle("overflows",distance>1);
      if(distance>1)element.tabIndex=0;else element.removeAttribute("tabindex");
      if(distance<=1||!element.clientWidth||motion.matches)continue;
      element.scrollLeft=0;const travel=distance/28,seconds=travel*2+4;
      item.animation=text.animate([
        {transform:"translateX(0)",offset:0},{transform:"translateX(0)",offset:2/seconds},
        {transform:"translateX(-"+distance+"px)",offset:(2+travel)/seconds},
        {transform:"translateX(-"+distance+"px)",offset:(4+travel)/seconds},
        {transform:"translateX(0)",offset:1}
      ],{duration:seconds*1000,iterations:Infinity,easing:"linear"});
      if(element.matches(":hover, :focus-within"))item.animation.pause();
    }
  }
  const observer=new ResizeObserver(measure);labels.forEach(item=>observer.observe(item.element));
  motion.addEventListener("change",measure);document.fonts.ready.then(measure);measure();
}

function nowPlayingHtml(nowPlaying = null, history = [], { previewImageUrl = "", pageUrl = "", brandName = "darthspader.com", stateUrl = "/now-state" } = {}) {
  const current = nowPlaying || {};
  const version = getNowVersion(nowPlaying);
  const title = cleanBridgeText(current.title || "Nothing Playing");
  const artist = cleanBridgeText(current.artist || "");
  const description = createNowDescription(nowPlaying, brandName);
  const subtitle = cleanBridgeText(current.signalPath || current.radioStationName || current.album || "");
  const artUrl = isHttpUrl(current.albumArtUrl) ? current.albumArtUrl : DEFAULT_NOW_ART_PATH;
  const bridgeUrl = isHttpUrl(current.bridgeUrl) ? current.bridgeUrl : "";
  const tidalUrl = isHttpUrl(current.tidalUrl) ? current.tidalUrl : createTidalSearchUrl(title, artist);
  const spotifyUrl = createSpotifySearchUrl(title, artist);
  const appleUrl = createAppleMusicWebSearchUrl(title, artist);
  const backgroundHtml = artUrl ? "<img class=\"bg\" src=\"" + htmlEscape(artUrl) + "\" alt=\"\">" : "";
  const coverHtml = artUrl ? "<img class=\"cover\" src=\"" + htmlEscape(artUrl) + "\" alt=\"Album art\">" : "<div class=\"cover empty\">RoonPresence</div>";
  const titleLinkStart = bridgeUrl ? "<a class=\"title-link\" href=\"" + htmlEscape(bridgeUrl) + "\">" : "";
  const titleLinkEnd = bridgeUrl ? "</a>" : "";
  const historyHtml = history.length
    ? history.map((item) => {
        const itemTitle = htmlEscape(item.title || "Unknown Track");
        const itemArtist = htmlEscape(item.artist || "");
        const itemArtUrl = isHttpUrl(item.albumArtUrl) ? item.albumArtUrl : DEFAULT_NOW_ART_PATH;
        const itemArt = "<img src=\"" + htmlEscape(itemArtUrl) + "\" alt=\"\">";
        const itemHref = isHttpUrl(item.bridgeUrl) ? item.bridgeUrl : "";
        const rowStart = itemHref ? "<a class=\"history-row\" href=\"" + htmlEscape(itemHref) + "\">" : "<div class=\"history-row\">";
        const rowEnd = itemHref ? "</a>" : "</div>";
        return rowStart + itemArt + "<div><strong>" + itemTitle + "</strong><p>" + itemArtist + "</p></div><time>" + htmlEscape(formatNowTime(item.updatedAt)) + "</time>" + rowEnd;
      }).join("")
    : "<p class=\"empty-history\">Recent tracks will appear here.</p>";

  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>" + htmlEscape(brandName) + " Now Playing</title>" +
    "<meta name=\"twitter:card\" content=\"summary_large_image\">" +
    "<meta name=\"twitter:title\" content=\"" + htmlEscape(brandName) + " Now Playing\">" +
    "<meta name=\"twitter:description\" content=\"" + htmlEscape(description) + "\">" +
    (previewImageUrl ? "<meta name=\"twitter:image\" content=\"" + htmlEscape(previewImageUrl) + "\">" : "") +
    "<meta property=\"og:title\" content=\"" + htmlEscape(brandName) + " Now Playing\">" +
    "<meta property=\"og:description\" content=\"" + htmlEscape(description) + "\">" +
    (previewImageUrl ? "<meta property=\"og:image\" content=\"" + htmlEscape(previewImageUrl) + "\">" : "") +
    (pageUrl ? "<meta property=\"og:url\" content=\"" + htmlEscape(pageUrl) + "\">" : "") +
    "<meta property=\"og:type\" content=\"website\">" +
    "<meta property=\"og:site_name\" content=\"" + htmlEscape(brandName) + "\">" +
    "<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#030304;color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:22px;overflow-x:hidden}.bg{position:fixed;inset:-48px;width:calc(100% + 96px);height:calc(100% + 96px);object-fit:cover;filter:blur(34px);opacity:.30;z-index:-2}body:before{content:\"\";position:fixed;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.52),rgba(0,0,0,.84));z-index:-1}.wrap{width:min(940px,100%);margin:0 auto}.brand{text-align:center;margin:8px 0 22px;font-weight:800;letter-spacing:.26em;color:rgba(190,205,255,.78)}.card{display:grid;grid-template-columns:minmax(170px,300px) minmax(0,1fr);gap:28px;align-items:center;padding:26px;border:1px solid rgba(255,255,255,.12);border-radius:30px;background:linear-gradient(180deg,rgba(18,18,20,.74),rgba(8,8,10,.64));box-shadow:0 28px 100px rgba(0,0,0,.55);backdrop-filter:blur(18px)}.cover{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.52)}.cover.empty{display:grid;place-items:center;background:#111;color:rgba(255,255,255,.6);font-weight:800}.eyebrow{margin:0 0 8px;color:rgba(255,255,255,.52);font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.12em}.refresh-note{margin:0 0 14px;color:rgba(255,255,255,.42);font-size:13px}.title-link{color:inherit;text-decoration:none}h1{margin:0 auto;text-align:center;text-wrap:balance;font-size:clamp(34px,7vw,64px);line-height:1.02}.artist{margin:14px auto 0;text-align:center;color:rgba(255,255,255,.68);font-size:clamp(22px,4vw,34px)}.subtitle{margin:18px auto 0;text-align:center;color:rgba(255,255,255,.56);font-size:17px;line-height:1.35}.actions{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:12px;margin-top:24px}.actions a{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:16px;border:1px solid rgba(255,255,255,.14);color:#fff;text-decoration:none;font-weight:850;background:rgba(255,255,255,.06)}.tidal{background:linear-gradient(180deg,#050505,#000)!important}.spotify{background:linear-gradient(180deg,rgba(30,215,96,.30),rgba(30,215,96,.10))!important}.apple{background:linear-gradient(135deg,#87184e,#e2145d 48%,#ff2f4f)!important}.section-title{margin:28px 0 12px;color:rgba(255,255,255,.72)}.history{display:grid;gap:10px}.history-row{display:grid;grid-template-columns:58px 1fr auto;gap:12px;align-items:center;padding:10px;border-radius:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:#fff;text-decoration:none}.history-row img,.history-row span{width:58px;height:58px;border-radius:10px;background:#151515;object-fit:cover}.history-row strong{display:block;font-size:15px}.history-row p{margin:3px 0 0;color:rgba(255,255,255,.56)}.history-row time{color:rgba(255,255,255,.45);font-size:13px}.empty-history{color:rgba(255,255,255,.55)}@media(max-width:720px){body{padding:16px}.card{grid-template-columns:1fr;padding:18px;gap:18px}.cover{width:min(100%,360px);margin:0 auto}.actions{grid-template-columns:1fr}.history-row{grid-template-columns:52px 1fr}.history-row time{display:none}}.card>div{min-width:0}.scrolling-label{white-space:nowrap;overflow:hidden;max-width:100%;text-wrap:nowrap}.scrolling-label.overflows{text-align:left}.scrolling-label>span{display:inline-block;white-space:nowrap}.scrolling-label:focus-visible{outline:2px solid #bdcaff;outline-offset:3px}@media(prefers-reduced-motion:reduce){.scrolling-label{overflow-x:auto;scrollbar-width:thin}}</style></head>" +
    "<body>" + backgroundHtml + "<main class=\"wrap\"><div class=\"brand\">" + htmlEscape(brandName) + "</div><section class=\"card\">" + coverHtml + "<div><p class=\"eyebrow\">Now Playing</p>" + titleLinkStart + "<h1>" + htmlEscape(title) + "</h1>" + titleLinkEnd + (artist ? "<p class=\"artist\">" + htmlEscape(artist) + "</p>" : "") + (subtitle ? "<p class=\"subtitle\">" + htmlEscape(subtitle) + "</p>" : "") + "<div class=\"actions\">" + (tidalUrl ? "<a class=\"tidal\" href=\"" + htmlEscape(tidalUrl) + "\">Play on TIDAL</a>" : "") + "<a class=\"spotify\" href=\"" + htmlEscape(spotifyUrl) + "\">Spotify</a><a class=\"apple\" href=\"" + htmlEscape(appleUrl) + "\">Apple Music</a></div></div></section><h2 class=\"section-title\">Recently Played</h2><section class=\"history\">" + historyHtml + "</section></main><script>" + "(" + installNowPlayingScroll.toString() + ")();" + "(function(){var current=" + JSON.stringify(version) + ";var stateUrl=" + JSON.stringify(stateUrl) + ";async function check(){try{var response=await fetch(stateUrl,{cache:'no-store'});if(!response.ok)return;var state=await response.json();if(state.version&&state.version!==current){window.location.reload();}}catch(error){}}setInterval(check,2000);})();</script></body></html>";
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
        const fallbackUrl = response.statusCode >= 500 ? roonImageFallbackUrl(url) : "";
        response.resume();
        if (fallbackUrl) {
          fetchBuffer(fallbackUrl, timeoutMs, redirectsRemaining).then(resolve, reject);
          return;
        }
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
    fetchImage = fetchBuffer,
    cacheDir = DEFAULT_CACHE_DIR,
    nowHistoryMax = DEFAULT_NOW_HISTORY_MAX,
    persistNowPlaying = false,
    bridgeUsername = "",
    bridgeBrandName = "",
    rabbitHoleBaseUrl = "",
    debugStateProvider = null
  } = {}) {
    this.publicBaseUrl = trimTrailingSlash(publicBaseUrl);
    this.port = Number(port) || DEFAULT_ALBUM_ART_PROXY_PORT;
    this.cacheMax = Number(cacheMax) || DEFAULT_ALBUM_ART_CACHE_MAX;
    this.bridgeUsername = cleanUserSlug(bridgeUsername);
    this.bridgeBrandName = cleanBrandName(bridgeBrandName || this.bridgeUsername || "RoonPresence");
    this.rabbitHoleBaseUrl = trimTrailingSlash(rabbitHoleBaseUrl);
    this.logger = logger;
    this.fetchImage = fetchImage;
    this.cacheDir = cacheDir;
    this.tidalBridgeCachePath = path.join(this.cacheDir, TIDAL_BRIDGE_CACHE_FILE);
    this.tidalBridgeCache = readJsonFile(this.tidalBridgeCachePath, {});
    this.artCacheDir = path.join(this.cacheDir, ART_CACHE_DIR_NAME);
    this.artCacheManifestPath = path.join(this.cacheDir, ART_CACHE_MANIFEST_FILE);
    this.artCacheManifest = readArtCacheManifest(this.artCacheManifestPath);
    this.nowHistoryMax = Number(nowHistoryMax) || DEFAULT_NOW_HISTORY_MAX;
    this.persistNowPlaying = !!persistNowPlaying;
    this.nowPlayingCachePath = path.join(this.cacheDir, NOW_PLAYING_CACHE_FILE);
    const nowCache = this.persistNowPlaying
      ? normalizeNowCache(readJsonFile(this.nowPlayingCachePath, {}), this.nowHistoryMax)
      : { nowPlaying: null, nowHistory: [] };
    this.nowPlaying = nowCache.nowPlaying;
    this.nowHistory = nowCache.nowHistory;
    this.debugStateProvider = typeof debugStateProvider === "function" ? debugStateProvider : null;
    this.server = null;
    this.entries = new Map();
    for (const [id, entry] of Object.entries(this.artCacheManifest)) {
      this.entries.set(id, { sourceUrl: entry.sourceUrl, buffer: null, fetchedAt: entry.fetchedAt });
    }
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

  updateConfig({ publicBaseUrl, port, cacheMax, rabbitHoleBaseUrl } = {}) {
    const nextPublicBaseUrl = trimTrailingSlash(publicBaseUrl);
    const nextPort = Number(port) || DEFAULT_ALBUM_ART_PROXY_PORT;
    const nextCacheMax = Number(cacheMax) || DEFAULT_ALBUM_ART_CACHE_MAX;
    const nextRabbitHoleBaseUrl = rabbitHoleBaseUrl === undefined
      ? this.rabbitHoleBaseUrl
      : trimTrailingSlash(rabbitHoleBaseUrl);
    const changed =
      nextPublicBaseUrl !== this.publicBaseUrl ||
      nextPort !== this.port ||
      nextCacheMax !== this.cacheMax ||
      nextRabbitHoleBaseUrl !== this.rabbitHoleBaseUrl;

    if (!changed) return false;

    const wasRunning = !!this.server;
    this.stop();
    this.publicBaseUrl = nextPublicBaseUrl;
    this.port = nextPort;
    this.cacheMax = nextCacheMax;
    this.rabbitHoleBaseUrl = nextRabbitHoleBaseUrl;
    this.entries.clear();
    for (const [id, entry] of Object.entries(this.artCacheManifest)) {
      this.entries.set(id, { sourceUrl: entry.sourceUrl, buffer: null, fetchedAt: entry.fetchedAt });
    }

    if (this.enabled) {
      this.start();
    } else if (wasRunning) {
      this.warnIfDisabled();
    }

    return true;
  }

  setDebugStateProvider(provider) {
    this.debugStateProvider = typeof provider === "function" ? provider : null;
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  getPublicUrl(sourceUrl, imageKey = "") {
    if (!this.enabled || !sourceUrl) return "";

    const existingId = this.getOwnPublicArtId(sourceUrl);
    if (existingId) return sourceUrl;

    const id = this.createId(sourceUrl, imageKey);
    this.remember(id, sourceUrl);
    return this.createPublicArtUrl(id, this.getCachedArtVersion(id));
  }

  createPublicArtUrl(id, version = 0) {
    if (!id) return "";
    const baseUrl = `${this.publicBaseUrl}/art/${id}.jpg`;
    const cleanVersion = Number(version) || 0;
    return cleanVersion > 0 ? `${baseUrl}?v=${encodeURIComponent(String(cleanVersion))}` : baseUrl;
  }

  getTidalBridgeUrl(tidalUrl, mode = "bridge", albumArtUrl = "", track = {}) {
    if (!this.enabled) return "";
    const trackId = getTidalTrackId(tidalUrl);
    if (!trackId) return "";
    this.rememberTidalBridgeMetadata(trackId, { albumArtUrl, ...track });

    const cleanMode = String(mode || "bridge").toLowerCase();
    const artQuery = createBridgeQuery({
      albumArtUrl,
      title: track.title,
      artist: track.artist
    });
    if (cleanMode === "intent" || cleanMode === "android") return this.publicBaseUrl + "/tidal/intent/" + trackId;
    if (cleanMode === "scheme") return this.publicBaseUrl + "/tidal/app/" + trackId;
    if (cleanMode === "manual") return this.publicBaseUrl + "/tidal/track/" + trackId;
    if (cleanMode === "web") return "";
    return this.publicBaseUrl + "/tidal/track/" + trackId + artQuery;
  }

  rememberTidalBridgeMetadata(trackId, metadata = {}) {
    const id = String(trackId || "").replace(/\D/g, "");
    if (!id) return false;

    const existing = this.tidalBridgeCache[id] || {};
    const next = {
      ...existing,
      updatedAt: Date.now()
    };
    const title = cleanBridgeText(metadata.title);
    const artist = cleanBridgeText(metadata.artist);
    const albumArtUrl = isHttpUrl(metadata.albumArtUrl) ? String(metadata.albumArtUrl).trim() : "";
    if (title) next.title = title;
    if (artist) next.artist = artist;
    if (albumArtUrl) next.albumArtUrl = albumArtUrl;
    if (metadata.tidalUrl) next.tidalUrl = String(metadata.tidalUrl).trim();

    if (!next.title && !next.artist && !next.albumArtUrl) return false;
    this.tidalBridgeCache[id] = next;
    writeJsonFile(this.tidalBridgeCachePath, this.tidalBridgeCache);
    return true;
  }

  getTidalBridgeMetadata(trackId) {
    return this.tidalBridgeCache[String(trackId || "").replace(/\D/g, "")] || {};
  }

  getNowPath() {
    return this.bridgeUsername ? `/now/u/${this.bridgeUsername}` : "/now";
  }

  getNowStatePath() {
    return this.bridgeUsername ? `/now-state/u/${this.bridgeUsername}` : "/now-state";
  }

  getNowOgPath() {
    return this.bridgeUsername ? `/og/now/u/${this.bridgeUsername}.png` : "/og/now.png";
  }

  getPublicNowUrl() {
    return this.enabled ? `${this.publicBaseUrl}${this.getNowPath()}` : "";
  }

  saveNowPlayingCache() {
    if (!this.persistNowPlaying) return;
    writeJsonFile(this.nowPlayingCachePath, {
      nowPlaying: this.nowPlaying,
      nowHistory: this.nowHistory
    });
  }

  updateNowPlaying(presence, rpcActivity = {}) {
    if (!presence) return false;

    const title = cleanBridgeText(presence.metadata?.title || presence.activity?.details);
    const artist = cleanBridgeText(presence.metadata?.artist);
    if (!title) return false;

    const albumArtUrl = isHttpUrl(rpcActivity.largeImageKey) ? rpcActivity.largeImageKey : "";
    const tidalButton = Array.isArray(rpcActivity.buttons)
      ? rpcActivity.buttons.find((button) => isTidalActivityButton(button))
      : null;
    const bridgeUrl = tidalButton?.url || "";
    const directTidalUrl =
      (isHttpUrl(presence.metadata?.tidalUrl) && getTidalTrackId(presence.metadata.tidalUrl) ? presence.metadata.tidalUrl : "") ||
      createTidalTrackUrl(getTidalBridgeTrackId(bridgeUrl));
    const now = {
      title,
      artist,
      album: cleanBridgeText(presence.metadata?.album),
      radioStationName: cleanBridgeText(presence.metadata?.radioStationName),
      signalPath: cleanBridgeText(presence.metadata?.signalPath || presence.activity?.state),
      timestampMode: presence.timestampMode || "",
      albumArtUrl,
      tidalUrl: directTidalUrl || bridgeUrl,
      bridgeUrl,
      updatedAt: Date.now()
    };
    const key = normalizeNowKey(now.title, now.artist);
    const previousKey = this.nowPlaying ? normalizeNowKey(this.nowPlaying.title, this.nowPlaying.artist) : "";
    const previousNowPlaying = this.nowPlaying;
    this.nowPlaying = now;

    if (previousKey && key !== previousKey) {
      const existingHistoryItem = this.nowHistory.find((item) =>
        normalizeNowKey(item.title, item.artist) === previousKey
      );
      const historyItem = mergeNowHistoryItem(existingHistoryItem, previousNowPlaying);
      this.nowHistory = [
        historyItem,
        ...this.nowHistory.filter((item) => normalizeNowKey(item.title, item.artist) !== previousKey)
      ].slice(0, this.nowHistoryMax);
    }

    this.saveNowPlayingCache();
    return true;
  }

  clearNowPlaying() {
    if (this.nowPlaying) {
      const key = normalizeNowKey(this.nowPlaying.title, this.nowPlaying.artist);
      if (key) {
        const existingHistoryItem = this.nowHistory.find((item) => normalizeNowKey(item.title, item.artist) === key);
        const historyItem = mergeNowHistoryItem(existingHistoryItem, this.nowPlaying);
        this.nowHistory = [
          historyItem,
          ...this.nowHistory.filter((item) => normalizeNowKey(item.title, item.artist) !== key)
        ].slice(0, this.nowHistoryMax);
      }
    }
    this.nowPlaying = null;
    this.saveNowPlayingCache();
  }

  async cachePublicUrl(sourceUrl, imageKey = "") {
    const publicUrl = this.getPublicUrl(sourceUrl, imageKey);
    if (!publicUrl) return "";

    const id = this.getOwnPublicArtId(publicUrl);
    const entry = id ? this.entries.get(id) : null;
    if (entry) {
      await this.ensureCachedArt(id, entry);
      return this.createPublicArtUrl(id, entry.fetchedAt);
    }
    return publicUrl;
  }

  async prefetchPublicUrl(sourceUrl, imageKey = "") {
    try {
      return await this.cachePublicUrl(sourceUrl, imageKey);
    } catch (error) {
      this.logger?.warn?.("Album art prefetch failed", { error: error.message });
      return this.getPublicUrl(sourceUrl, imageKey);
    }
  }

  createId(sourceUrl, imageKey = "") {
    return crypto
      .createHash("sha1")
      .update(`${imageKey}\n${sourceUrl}`)
      .digest("hex");
  }

  getOwnPublicArtId(value) {
    const url = String(value || "");
    if (!this.enabled || !url.startsWith(`${this.publicBaseUrl}/art/`)) return "";
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    const match = /\/art\/([a-f0-9]{40})\.jpg$/i.exec(pathname);
    return match ? match[1] : "";
  }

  getCachedArtVersion(id) {
    const entry = this.entries.get(id);
    if (!this.hasCachedArt(id, entry)) return 0;
    return Number(entry?.fetchedAt || this.artCacheManifest[id]?.fetchedAt || 0) || 0;
  }

  remember(id, sourceUrl) {
    const existing = this.entries.get(id);
    this.entries.delete(id);
    const entry = existing || this.createEntryFromManifest(id, sourceUrl);
    this.entries.set(id, entry);
    this.rememberArtManifest(id, entry);

    while (this.entries.size > this.cacheMax) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      this.forgetCachedArt(oldest);
    }
  }

  createEntryFromManifest(id, sourceUrl = "") {
    const existing = this.artCacheManifest[id] || {};
    return {
      sourceUrl: existing.sourceUrl || sourceUrl,
      buffer: null,
      fetchedAt: Number(existing.fetchedAt) || 0
    };
  }

  getCachedArtPath(id) {
    return path.join(this.artCacheDir, `${id}.jpg`);
  }

  readCachedArt(id) {
    try {
      return fs.readFileSync(this.getCachedArtPath(id));
    } catch {
      return null;
    }
  }

  writeCachedArt(id, buffer, entry) {
    fs.mkdirSync(this.artCacheDir, { recursive: true });
    fs.writeFileSync(this.getCachedArtPath(id), buffer);
    this.rememberArtManifest(id, entry);
  }

  rememberArtManifest(id, entry) {
    if (!entry?.sourceUrl) return;
    this.artCacheManifest[id] = {
      sourceUrl: entry.sourceUrl,
      fetchedAt: Number(entry.fetchedAt) || 0
    };
    writeJsonFile(this.artCacheManifestPath, this.artCacheManifest);
  }

  forgetCachedArt(id) {
    delete this.artCacheManifest[id];
    writeJsonFile(this.artCacheManifestPath, this.artCacheManifest);
    try {
      fs.unlinkSync(this.getCachedArtPath(id));
    } catch {}
  }

  async ensureCachedArt(id, entry) {
    if (!entry.buffer) {
      entry.buffer = this.readCachedArt(id);
    }

    if (!entry.buffer) {
      entry.buffer = await this.fetchImage(entry.sourceUrl);
      entry.fetchedAt = Date.now();
      this.writeCachedArt(id, entry.buffer, entry);
    }

    return entry.buffer;
  }

  hasCachedArt(id, entry = null) {
    return !!entry?.buffer || fs.existsSync(this.getCachedArtPath(id));
  }

  serveFallbackArt(response) {
    const fallbackBuffer = getAssetBuffer(ASSET_PATHS[DEFAULT_NOW_ART_PATH]);
    response.writeHead(200, {
      "content-type": getAssetContentType(ASSET_PATHS[DEFAULT_NOW_ART_PATH]),
      "cache-control": "no-cache",
      "content-length": fallbackBuffer.length
    });
    response.end(fallbackBuffer);
  }

  serveMissingArt(response) {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end("art not cached");
  }

  getDisplayAlbumArtUrl(albumArtUrl) {
    if (!isHttpUrl(albumArtUrl)) return "";
    return albumArtUrl;
  }

  getDisplayNowItem(item) {
    if (!item) return null;
    return {
      ...item,
      albumArtUrl: this.getDisplayAlbumArtUrl(item.albumArtUrl)
    };
  }

  async handleArtCacheRequest(request, response, parsedUrl) {
    const method = String(request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      writeJson(response, 405, { ok: false, error: "method not allowed" }, { allow: "GET, POST" });
      return;
    }

    let payload = {};
    if (method === "POST") {
      const body = await readRequestBody(request);
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        writeJson(response, 400, { ok: false, error: "invalid json" });
        return;
      }
    }

    const sourceUrl = String(
      payload.sourceUrl ||
      payload.url ||
      payload.albumArtUrl ||
      parsedUrl.searchParams.get("sourceUrl") ||
      parsedUrl.searchParams.get("url") ||
      parsedUrl.searchParams.get("art") ||
      ""
    ).trim();
    const title = cleanBridgeText(payload.title || parsedUrl.searchParams.get("title") || "");
    const artist = cleanBridgeText(payload.artist || parsedUrl.searchParams.get("artist") || "");
    const imageKey = cleanBridgeText(
      payload.imageKey ||
      parsedUrl.searchParams.get("imageKey") ||
      (artist || title ? `bridge:${artist}|${title}` : "")
    );

    if (!this.enabled) {
      writeJson(response, 503, { ok: false, error: "album art bridge disabled" });
      return;
    }
    if (!isAllowedBridgeArtworkSource(sourceUrl, this.publicBaseUrl)) {
      writeJson(response, 400, { ok: false, error: "artwork source not allowed" });
      return;
    }

    const publicUrl = this.getPublicUrl(sourceUrl, imageKey);
    const id = this.getOwnPublicArtId(publicUrl);
    const cached = Boolean(id && this.hasCachedArt(id, this.entries.get(id)));
    this.prefetchPublicUrl(sourceUrl, imageKey).catch(() => {});

    writeJson(response, 200, {
      ok: true,
      url: publicUrl,
      imageKey,
      cached,
      deferred: !cached
    });
  }

  async handleMcpProxyRequest(request, response, parsedUrl) {
    if (!this.rabbitHoleBaseUrl) {
      writeJson(response, 503, {
        ok: false,
        error: "Rabbit Hole MCP upstream is not configured"
      }, mcpCorsHeaders());
      return;
    }

    const targetUrl = `${this.rabbitHoleBaseUrl}${parsedUrl.pathname}${parsedUrl.search}`;
    const method = String(request.method || "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD"
      ? undefined
      : await readRequestBody(request, MCP_PROXY_MAX_BODY_BYTES);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method,
        headers: copyProxyRequestHeaders(request.headers || {}),
        body
      });
    } catch (error) {
      this.logger?.warn?.("Rabbit Hole MCP proxy failed", {
        targetUrl,
        error: error.message
      });
      writeJson(response, 502, {
        ok: false,
        error: "Rabbit Hole MCP upstream unavailable",
        detail: error.message
      }, mcpCorsHeaders());
      return;
    }

    response.writeHead(upstream.status, copyProxyResponseHeaders(upstream.headers));
    if (method === "HEAD" || !upstream.body) {
      response.end();
      return;
    }

    if (Readable.fromWeb && typeof response.write === "function") {
      await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(upstream.body);
        stream.on("error", reject);
        response.on?.("error", reject);
        response.on?.("finish", resolve);
        stream.pipe(response);
      });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.end(buffer);
  }

  async handleRabbitHoleTidalOAuthProxyRequest(request, response, parsedUrl) {
    if (!this.rabbitHoleBaseUrl) {
      writeJson(response, 503, {
        ok: false,
        error: "Rabbit Hole upstream is not configured"
      });
      return;
    }

    const method = String(request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      writeJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const targetUrl = `${this.rabbitHoleBaseUrl}${parsedUrl.pathname}${parsedUrl.search}`;
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method,
        redirect: "manual",
        headers: forwardedRabbitHoleWebHeaders(request.headers || {}, this.publicBaseUrl)
      });
    } catch (error) {
      this.logger?.warn?.("Rabbit Hole TIDAL OAuth proxy failed", {
        targetUrl,
        error: error.message
      });
      writeJson(response, 502, {
        ok: false,
        error: "Rabbit Hole upstream unavailable",
        detail: error.message
      });
      return;
    }

    response.writeHead(upstream.status, copyRabbitHoleWebResponseHeaders(upstream.headers));
    if (method === "HEAD" || !upstream.body) {
      response.end();
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.end(buffer);
  }

  async handleRequest(request, response) {
    const parsedUrl = new URL(request.url || "/", "http://localhost");
    const requestPath = parsedUrl.pathname;
    const albumArtUrl = parsedUrl.searchParams.get("art") || "";

    if (requestPath === "/mcp" || requestPath === "/mcp/") {
      await this.handleMcpProxyRequest(request, response, parsedUrl);
      return;
    }

    if (RABBIT_HOLE_TIDAL_OAUTH_PROXY_RE.test(requestPath)) {
      await this.handleRabbitHoleTidalOAuthProxyRequest(request, response, parsedUrl);
      return;
    }

    if (requestPath === "/debug/discord") {
      writeJson(response, 200, {
        ok: true,
        discord: this.debugStateProvider ? this.debugStateProvider() : null,
        nowPlaying: this.getDisplayNowItem(this.nowPlaying),
        updatedAt: Date.now()
      });
      return;
    }

    if (requestPath === "/api/art/cache") {
      await this.handleArtCacheRequest(request, response, parsedUrl);
      return;
    }

    if (ASSET_PATHS[requestPath]) {
      const logoBuffer = getAssetBuffer(ASSET_PATHS[requestPath]);
      response.writeHead(200, {
        "content-type": getAssetContentType(ASSET_PATHS[requestPath]),
        "cache-control": "no-cache",
        "content-length": logoBuffer.length
      });
      response.end(logoBuffer);
      return;
    }

    const tidalIntentMatch = /^\/tidal\/intent\/(\d+)$/i.exec(requestPath);
    if (tidalIntentMatch) {
      const webUrl = "https://tidal.com/browse/track/" + tidalIntentMatch[1];
      const intentUrl = createTidalAndroidIntent(tidalIntentMatch[1], webUrl);
      response.writeHead(302, {
        location: intentUrl,
        "cache-control": "no-store"
      });
      response.end();
      return;
    }

    const tidalAppMatch = /^\/tidal\/app\/(\d+)$/i.exec(requestPath);
    if (tidalAppMatch) {
      response.writeHead(302, {
        location: "tidal://track/" + tidalAppMatch[1],
        "cache-control": "no-store"
      });
      response.end();
      return;
    }

    const tidalManualMatch = /^\/tidal\/manual\/(\d+)$/i.exec(requestPath);
    if (tidalManualMatch) {
      const requestMetadata = {
        title: parsedUrl.searchParams.get("title") || "",
        artist: parsedUrl.searchParams.get("artist") || "",
        albumArtUrl,
        tidalUrl: "https://tidal.com/browse/track/" + tidalManualMatch[1]
      };
      this.rememberTidalBridgeMetadata(tidalManualMatch[1], requestMetadata);
      response.writeHead(302, {
        location: "/tidal/track/" + tidalManualMatch[1],
        "cache-control": "no-store"
      });
      response.end();
      return;
    }

    const tidalMatch = /^\/tidal\/track\/(\d+)$/i.exec(requestPath);
    if (tidalMatch) {
      const requestMetadata = {
        title: parsedUrl.searchParams.get("title") || "",
        artist: parsedUrl.searchParams.get("artist") || "",
        albumArtUrl,
        tidalUrl: "https://tidal.com/browse/track/" + tidalMatch[1]
      };
      this.rememberTidalBridgeMetadata(tidalMatch[1], requestMetadata);
      const cachedMetadata = this.getTidalBridgeMetadata(tidalMatch[1]);
      const finalMetadata = {
        title: requestMetadata.title || cachedMetadata.title || "",
        artist: requestMetadata.artist || cachedMetadata.artist || "",
        albumArtUrl: requestMetadata.albumArtUrl || cachedMetadata.albumArtUrl || ""
      };
      const shareUrl = `${this.publicBaseUrl}/tidal/track/${tidalMatch[1]}`;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(tidalTrackHtml(tidalMatch[1], finalMetadata.albumArtUrl, {
        title: finalMetadata.title,
        artist: finalMetadata.artist,
        pageUrl: getRequestPublicUrl(request, parsedUrl) || shareUrl,
        shareUrl,
        brandName: this.bridgeBrandName
      }));
      return;
    }

    const nowUserMatch = /^\/now\/u\/([^/]+)$/i.exec(requestPath);
    const requestedNowUser = nowUserMatch ? cleanUserSlug(nowUserMatch[1]) : "";
    const nowUserMatches = !!nowUserMatch && !!requestedNowUser && (!this.bridgeUsername || requestedNowUser === this.bridgeUsername);
    if (nowUserMatch && !nowUserMatches) {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Not found</title><body style=\"font-family:system-ui;background:#050507;color:#fff;display:grid;min-height:100vh;place-items:center;margin:0\"><main><h1>Bridge user not found</h1><p>Check the username in the URL.</p></main></body>");
      return;
    }

    if (requestPath === "/now" || requestPath === "/history" || nowUserMatches) {
      const previewVersion = getNowPreviewVersion(this.nowPlaying);
      const nowPath = nowUserMatches ? `/now/u/${requestedNowUser}` : this.getNowPath();
      const nowOgPath = nowUserMatches ? `/og/now/u/${requestedNowUser}.png` : this.getNowOgPath();
      const nowStatePath = nowUserMatches ? `/now-state/u/${requestedNowUser}` : this.getNowStatePath();
      const previewImageUrl = this.enabled
        ? `${this.publicBaseUrl}${nowOgPath}?v=${encodeURIComponent(previewVersion)}`
        : "";
      const pageUrl = this.enabled ? `${this.publicBaseUrl}${nowPath}` : getRequestPublicUrl(request, parsedUrl);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(nowPlayingHtml(
        this.getDisplayNowItem(this.nowPlaying),
        this.nowHistory.map((item) => this.getDisplayNowItem(item)).filter(Boolean),
        {
        previewImageUrl,
        pageUrl,
        brandName: this.bridgeBrandName,
        stateUrl: nowStatePath
        }
      ));
      return;
    }

    const nowOgUserMatch = /^\/og\/now\/u\/([^/]+)\.png$/i.exec(requestPath);
    const requestedNowOgUser = nowOgUserMatch ? cleanUserSlug(nowOgUserMatch[1]) : "";
    const nowOgUserMatches = !!nowOgUserMatch && !!requestedNowOgUser && (!this.bridgeUsername || requestedNowOgUser === this.bridgeUsername);
    if (nowOgUserMatch && !nowOgUserMatches) {
      response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("bridge user not found");
      return;
    }

    if (requestPath === "/og/now.png" || nowOgUserMatches) {
      const image = await createNowOgImage(this.nowPlaying, this.fetchImage, { brandName: this.bridgeBrandName });
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
        "content-length": image.length
      });
      response.end(image);
      return;
    }

    const nowStateUserMatch = /^\/now-state\/u\/([^/]+)$/i.exec(requestPath);
    const requestedNowStateUser = nowStateUserMatch ? cleanUserSlug(nowStateUserMatch[1]) : "";
    const nowStateUserMatches = !!nowStateUserMatch && !!requestedNowStateUser && (!this.bridgeUsername || requestedNowStateUser === this.bridgeUsername);
    if (nowStateUserMatch && !nowStateUserMatches) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "bridge user not found" }));
      return;
    }

    if (requestPath === "/now-state" || nowStateUserMatches) {
      const body = JSON.stringify({
        version: getNowVersion(this.nowPlaying),
        nowPlaying: this.getDisplayNowItem(this.nowPlaying),
        updatedAt: this.nowPlaying?.updatedAt || 0
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body)
      });
      response.end(body);
      return;
    }

    const match = /^\/art\/([a-f0-9]{40})\.jpg$/i.exec(requestPath);
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    const entry = this.entries.get(match[1]);
    if (!entry) {
      this.serveMissingArt(response);
      return;
    }

    let buffer = null;
    try {
      buffer = await this.ensureCachedArt(match[1], entry);
    } catch (error) {
      entry.buffer = null;
      this.logger?.warn?.("Album art fetch failed; serving fallback artwork", {
        error: error.message,
        sourceUrl: entry.sourceUrl
      });
      this.serveMissingArt(response);
      return;
    }

    response.writeHead(200, {
      "content-type": "image/jpeg",
      "cache-control": "public, max-age=3600",
      "content-length": buffer.length
    });
    response.end(buffer);
  }
}

module.exports = {
  AlbumArtProxy,
  DEFAULT_ALBUM_ART_PROXY_PORT,
  DEFAULT_ALBUM_ART_CACHE_MAX,
  isUsablePublicBaseUrl,
  fetchBuffer
};

