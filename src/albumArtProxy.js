const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const DEFAULT_ALBUM_ART_PROXY_PORT = 8787;
const DEFAULT_ALBUM_ART_CACHE_MAX = 40;
const ASSET_PATHS = {
  "/assets/tidal-logo.png": path.join(__dirname, "..", "assets", "tidal-logo.png"),
  "/assets/spotify-full-logo.png": path.join(__dirname, "..", "assets", "spotify-full-logo.png"),
  "/assets/apple-music-logo.png": path.join(__dirname, "..", "assets", "apple-music-logo.png")
};
const DEFAULT_CACHE_DIR = path.join(__dirname, "..", ".cache");
const TIDAL_BRIDGE_CACHE_FILE = "tidal-bridge-cache.json";
const assetBuffers = new Map();
const DEFAULT_NOW_HISTORY_MAX = 25;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function isUsablePublicBaseUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
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

function formatNowTime(value) {
  if (!Number.isFinite(value)) return "";
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function normalizeNowKey(title = "", artist = "") {
  return `${cleanBridgeText(artist).toLowerCase()}|${cleanBridgeText(title).toLowerCase()}`;
}

function getAssetBuffer(assetPath) {
  if (!assetBuffers.has(assetPath)) {
    assetBuffers.set(assetPath, fs.readFileSync(assetPath));
  }
  return assetBuffers.get(assetPath);
}

function createMusicSearchQuery(title = "", artist = "") {
  return cleanBridgeText([title, artist].filter(Boolean).join(" "), 220);
}

function createSpotifySearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query ? "https://open.spotify.com/search/" + encodeURIComponent(query) : "https://open.spotify.com/search";
}

function createAppleMusicSearchUrl(title = "", artist = "") {
  const query = createMusicSearchQuery(title, artist);
  return query ? "https://music.apple.com/us/search?term=" + encodeURIComponent(query) : "https://music.apple.com/us/search";
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

function getRequestPublicUrl(request, parsedUrl) {
  const host = request.headers?.["x-forwarded-host"] || request.headers?.host || "";
  if (!host) return "";
  const proto = request.headers?.["x-forwarded-proto"] || "https";
  return `${proto}://${host}${parsedUrl.pathname}${parsedUrl.search}`;
}

function tidalTrackHtml(trackId, albumArtUrl = "", { title = "", artist = "", pageUrl = "", shareUrl = "" } = {}) {
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
    "<meta property=\"og:site_name\" content=\"darthspader.com\">" +
    "<meta property=\"og:title\" content=\"" + htmlEscape(pageTitle) + "\">" +
    "<meta property=\"og:description\" content=\"" + htmlEscape(pageDescription) + "\">" +
    "<meta property=\"og:url\" content=\"" + htmlEscape(metaUrl) + "\">" +
    (metaImage ? "<meta property=\"og:image\" content=\"" + htmlEscape(metaImage) + "\">" : "") +
    "<meta name=\"twitter:card\" content=\"" + (metaImage ? "summary_large_image" : "summary") + "\">" +
    "<meta name=\"twitter:title\" content=\"" + htmlEscape(pageTitle) + "\">" +
    "<meta name=\"twitter:description\" content=\"" + htmlEscape(pageDescription) + "\">" +
    (metaImage ? "<meta name=\"twitter:image\" content=\"" + htmlEscape(metaImage) + "\">" : "");
  const brandHtml = "<header class=\"brand\"><div class=\"brand-word\">darthspader.com</div></header>";
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

function nowPlayingHtml(nowPlaying = null, history = []) {
  const current = nowPlaying || {};
  const title = cleanBridgeText(current.title || "Nothing Playing");
  const artist = cleanBridgeText(current.artist || "");
  const subtitle = cleanBridgeText(current.signalPath || current.radioStationName || current.album || "");
  const artUrl = isHttpUrl(current.albumArtUrl) ? current.albumArtUrl : "";
  const bridgeUrl = isHttpUrl(current.bridgeUrl) ? current.bridgeUrl : "";
  const tidalUrl = isHttpUrl(current.tidalUrl) ? current.tidalUrl : "";
  const spotifyUrl = createSpotifySearchUrl(title, artist);
  const appleUrl = createAppleMusicSearchUrl(title, artist);
  const backgroundHtml = artUrl ? "<img class=\"bg\" src=\"" + htmlEscape(artUrl) + "\" alt=\"\">" : "";
  const coverHtml = artUrl ? "<img class=\"cover\" src=\"" + htmlEscape(artUrl) + "\" alt=\"Album art\">" : "<div class=\"cover empty\">RoonPresence</div>";
  const titleLinkStart = bridgeUrl ? "<a class=\"title-link\" href=\"" + htmlEscape(bridgeUrl) + "\">" : "";
  const titleLinkEnd = bridgeUrl ? "</a>" : "";
  const historyHtml = history.length
    ? history.map((item) => {
        const itemTitle = htmlEscape(item.title || "Unknown Track");
        const itemArtist = htmlEscape(item.artist || "");
        const itemArt = isHttpUrl(item.albumArtUrl) ? "<img src=\"" + htmlEscape(item.albumArtUrl) + "\" alt=\"\">" : "<span></span>";
        const itemHref = isHttpUrl(item.bridgeUrl) ? item.bridgeUrl : "";
        const rowStart = itemHref ? "<a class=\"history-row\" href=\"" + htmlEscape(itemHref) + "\">" : "<div class=\"history-row\">";
        const rowEnd = itemHref ? "</a>" : "</div>";
        return rowStart + itemArt + "<div><strong>" + itemTitle + "</strong><p>" + itemArtist + "</p></div><time>" + htmlEscape(formatNowTime(item.updatedAt)) + "</time>" + rowEnd;
      }).join("")
    : "<p class=\"empty-history\">Recent tracks will appear here.</p>";

  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>RoonPresence Now Playing</title>" +
    "<meta property=\"og:title\" content=\"" + htmlEscape(title + (artist ? " - " + artist : "")) + "\">" +
    "<meta property=\"og:site_name\" content=\"darthspader.com\">" +
    (artUrl ? "<meta property=\"og:image\" content=\"" + htmlEscape(artUrl) + "\">" : "") +
    "<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#030304;color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:22px;overflow-x:hidden}.bg{position:fixed;inset:-48px;width:calc(100% + 96px);height:calc(100% + 96px);object-fit:cover;filter:blur(34px);opacity:.30;z-index:-2}body:before{content:\"\";position:fixed;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.52),rgba(0,0,0,.84));z-index:-1}.wrap{width:min(940px,100%);margin:0 auto}.brand{text-align:center;margin:8px 0 22px;font-weight:800;letter-spacing:.26em;color:rgba(190,205,255,.78)}.card{display:grid;grid-template-columns:minmax(170px,300px) 1fr;gap:28px;align-items:center;padding:26px;border:1px solid rgba(255,255,255,.12);border-radius:30px;background:linear-gradient(180deg,rgba(18,18,20,.74),rgba(8,8,10,.64));box-shadow:0 28px 100px rgba(0,0,0,.55);backdrop-filter:blur(18px)}.cover{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.52)}.cover.empty{display:grid;place-items:center;background:#111;color:rgba(255,255,255,.6);font-weight:800}.eyebrow{margin:0 0 8px;color:rgba(255,255,255,.52);font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.12em}.title-link{color:inherit;text-decoration:none}h1{margin:0 auto;text-align:center;text-wrap:balance;font-size:clamp(34px,7vw,64px);line-height:1.02}.artist{margin:14px auto 0;text-align:center;color:rgba(255,255,255,.68);font-size:clamp(22px,4vw,34px)}.subtitle{margin:18px auto 0;text-align:center;color:rgba(255,255,255,.56);font-size:17px;line-height:1.35}.actions{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:12px;margin-top:24px}.actions a{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:16px;border:1px solid rgba(255,255,255,.14);color:#fff;text-decoration:none;font-weight:850;background:rgba(255,255,255,.06)}.tidal{background:linear-gradient(180deg,#050505,#000)!important}.spotify{background:linear-gradient(180deg,rgba(30,215,96,.30),rgba(30,215,96,.10))!important}.apple{background:linear-gradient(135deg,#87184e,#e2145d 48%,#ff2f4f)!important}.section-title{margin:28px 0 12px;color:rgba(255,255,255,.72)}.history{display:grid;gap:10px}.history-row{display:grid;grid-template-columns:58px 1fr auto;gap:12px;align-items:center;padding:10px;border-radius:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:#fff;text-decoration:none}.history-row img,.history-row span{width:58px;height:58px;border-radius:10px;background:#151515;object-fit:cover}.history-row strong{display:block;font-size:15px}.history-row p{margin:3px 0 0;color:rgba(255,255,255,.56)}.history-row time{color:rgba(255,255,255,.45);font-size:13px}.empty-history{color:rgba(255,255,255,.55)}@media(max-width:720px){body{padding:16px}.card{grid-template-columns:1fr;padding:18px;gap:18px}.cover{width:min(100%,360px);margin:0 auto}.actions{grid-template-columns:1fr}.history-row{grid-template-columns:52px 1fr}.history-row time{display:none}}</style></head>" +
    "<body>" + backgroundHtml + "<main class=\"wrap\"><div class=\"brand\">darthspader.com</div><section class=\"card\">" + coverHtml + "<div><p class=\"eyebrow\">Now Playing</p>" + titleLinkStart + "<h1>" + htmlEscape(title) + "</h1>" + titleLinkEnd + (artist ? "<p class=\"artist\">" + htmlEscape(artist) + "</p>" : "") + (subtitle ? "<p class=\"subtitle\">" + htmlEscape(subtitle) + "</p>" : "") + "<div class=\"actions\">" + (tidalUrl ? "<a class=\"tidal\" href=\"" + htmlEscape(tidalUrl) + "\">Play on TIDAL</a>" : "") + "<a class=\"spotify\" href=\"" + htmlEscape(spotifyUrl) + "\">Spotify</a><a class=\"apple\" href=\"" + htmlEscape(appleUrl) + "\">Apple Music</a></div></div></section><h2 class=\"section-title\">Recently Played</h2><section class=\"history\">" + historyHtml + "</section></main></body></html>";
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
    fetchImage = fetchBuffer,
    cacheDir = DEFAULT_CACHE_DIR,
    nowHistoryMax = DEFAULT_NOW_HISTORY_MAX
  } = {}) {
    this.publicBaseUrl = trimTrailingSlash(publicBaseUrl);
    this.port = Number(port) || DEFAULT_ALBUM_ART_PROXY_PORT;
    this.cacheMax = Number(cacheMax) || DEFAULT_ALBUM_ART_CACHE_MAX;
    this.logger = logger;
    this.fetchImage = fetchImage;
    this.cacheDir = cacheDir;
    this.tidalBridgeCachePath = path.join(this.cacheDir, TIDAL_BRIDGE_CACHE_FILE);
    this.tidalBridgeCache = readJsonFile(this.tidalBridgeCachePath, {});
    this.nowHistoryMax = Number(nowHistoryMax) || DEFAULT_NOW_HISTORY_MAX;
    this.nowPlaying = null;
    this.nowHistory = [];
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

    const existingId = this.getOwnPublicArtId(sourceUrl);
    if (existingId) return sourceUrl;

    const id = this.createId(sourceUrl, imageKey);
    this.remember(id, sourceUrl);
    return `${this.publicBaseUrl}/art/${id}.jpg`;
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

  updateNowPlaying(presence, rpcActivity = {}) {
    if (!presence) return false;

    const title = cleanBridgeText(presence.metadata?.title || presence.activity?.details);
    const artist = cleanBridgeText(presence.metadata?.artist);
    if (!title) return false;

    const albumArtUrl = isHttpUrl(rpcActivity.largeImageKey) ? rpcActivity.largeImageKey : "";
    const tidalButton = Array.isArray(rpcActivity.buttons)
      ? rpcActivity.buttons.find((button) => /tidal/i.test(button?.label || "") && isHttpUrl(button?.url || ""))
      : null;
    const bridgeUrl = tidalButton?.url || "";
    const now = {
      title,
      artist,
      album: cleanBridgeText(presence.metadata?.album),
      radioStationName: cleanBridgeText(presence.metadata?.radioStationName),
      signalPath: cleanBridgeText(presence.metadata?.signalPath || presence.activity?.state),
      timestampMode: presence.timestampMode || "",
      albumArtUrl,
      tidalUrl: bridgeUrl,
      bridgeUrl,
      updatedAt: Date.now()
    };
    const key = normalizeNowKey(now.title, now.artist);
    const previousKey = this.nowPlaying ? normalizeNowKey(this.nowPlaying.title, this.nowPlaying.artist) : "";
    this.nowPlaying = now;

    if (key && key !== previousKey) {
      this.nowHistory = [
        now,
        ...this.nowHistory.filter((item) => normalizeNowKey(item.title, item.artist) !== key)
      ].slice(0, this.nowHistoryMax);
    }

    return true;
  }

  clearNowPlaying() {
    this.nowPlaying = null;
  }

  async cachePublicUrl(sourceUrl, imageKey = "") {
    const publicUrl = this.getPublicUrl(sourceUrl, imageKey);
    if (!publicUrl) return "";

    const id = this.getOwnPublicArtId(publicUrl);
    const entry = id ? this.entries.get(id) : null;
    if (entry && !entry.buffer) {
      entry.buffer = await this.fetchImage(entry.sourceUrl);
      entry.fetchedAt = Date.now();
    }
    return publicUrl;
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
    const match = /\/art\/([a-f0-9]{40})\.jpg$/i.exec(url);
    return match ? match[1] : "";
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
    const parsedUrl = new URL(request.url || "/", "http://localhost");
    const requestPath = parsedUrl.pathname;
    const albumArtUrl = parsedUrl.searchParams.get("art") || "";

    if (ASSET_PATHS[requestPath]) {
      const logoBuffer = getAssetBuffer(ASSET_PATHS[requestPath]);
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
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
        shareUrl
      }));
      return;
    }

    if (requestPath === "/now" || requestPath === "/history") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(nowPlayingHtml(this.nowPlaying, this.nowHistory));
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

