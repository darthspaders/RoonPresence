const fs = require("fs");
const path = require("path");

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;

  for (const [key, value] of Object.entries(readDotEnvFile(filePath))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readDotEnvFile(filePath = path.resolve(process.cwd(), ".env")) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsAt = line.indexOf("=");
    if (equalsAt === -1) continue;

    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function readRuntimeEnv() {
  return {
    ...process.env,
    ...readDotEnvFile()
  };
}

function readConfig() {
  loadDotEnv();
  return configFromEnv(process.env);
}

function readConfigFresh() {
  return configFromEnv(readRuntimeEnv());
}

function configFromEnv(env) {
  return {
    discordClientId: env.DISCORD_CLIENT_ID || "",
    discordDefaultImageKey: env.DISCORD_DEFAULT_IMAGE_KEY || "roonpresence",
    hqplayerZoneMatch: env.HQPLAYER_ZONE_MATCH || "HQPlayer",
    hqplayer: {
      signalPathCommand: env.HQPLAYER_SIGNAL_PATH_COMMAND || "",
      signalPathStatic: env.HQPLAYER_SIGNAL_PATH_STATIC || "",
      signalPathPrefix: env.HQPLAYER_SIGNAL_PATH_PREFIX || "",
      statusCommand: env.HQPLAYER_STATUS_COMMAND || "",
      rateCommand: env.HQPLAYER_RATE_COMMAND || "",
      pollMs: Number(env.HQPLAYER_SIGNAL_PATH_POLL_MS || 5000)
    },
    debugDiscordPayload: /^(1|true|yes)$/i.test(env.DEBUG_DISCORD_PAYLOAD || ""),
    memoryLogMs: Number(env.MEMORY_LOG_MS || 0),
    tidalButton: {
      enabled: !/^(0|false|no)$/i.test(env.TIDAL_BUTTON_ENABLED || "true"),
      label: env.TIDAL_BUTTON_LABEL || "Play on TIDAL",
      searchBaseUrl: env.TIDAL_SEARCH_BASE_URL || "https://tidal.com/search?q="
    },
    albumArt: {
      publicBaseUrl: env.ALBUM_ART_PUBLIC_BASE_URL || "",
      proxyPort: Number(env.ALBUM_ART_PROXY_PORT || 8787),
      cacheMax: Number(env.ALBUM_ART_CACHE_MAX || 40)
    },
    radioMetadata: {
      enabled: !/^(0|false|no)$/i.test(env.RADIO_METADATA_LOOKUP || "true"),
      cacheMax: Number(env.RADIO_METADATA_CACHE_MAX || 200),
      minLookupIntervalMs: Number(env.RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS || 1500),
      discogsEnabled: !/^(0|false|no)$/i.test(env.DISCOGS_LOOKUP || "true"),
      discogsToken: env.DISCOGS_TOKEN || ""
    },
    roon: {
      extension_id: env.ROON_EXTENSION_ID || "com.example.roon-discord-cli",
      display_name: env.ROON_DISPLAY_NAME || "RoonPresence",
      display_version: env.ROON_DISPLAY_VERSION || "0.1.0",
      publisher: env.ROON_PUBLISHER || "Local CLI",
      email: env.ROON_EMAIL || ""
    },
    logLevel: env.LOG_LEVEL || "info"
  };
}

module.exports = { loadDotEnv, readConfig, readConfigFresh, readDotEnvFile };

