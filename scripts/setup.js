const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { readDotEnvFile } = require("../src/env");

const ENV_PATH = path.resolve(process.cwd(), ".env");
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), ".env.example");

const DEFAULTS = {
  DISCORD_CLIENT_ID: "",
  DISCORD_DEFAULT_IMAGE_KEY: "roonpresence",
  HQPLAYER_ZONE_MATCH: "HQPlayer",
  HQPLAYER_SIGNAL_PATH_STATIC: "",
  HQPLAYER_SIGNAL_PATH_PREFIX: "poly-sinc-gauss-hires-mp, TPDF, PCM",
  HQPLAYER_SIGNAL_PATH_COMMAND: "",
  HQPLAYER_STATUS_COMMAND: "",
  HQPLAYER_RATE_COMMAND: '"C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --state',
  HQPLAYER_SIGNAL_PATH_POLL_MS: "60000",
  ROON_EXTENSION_ID: "com.example.roon-discord-cli",
  ROON_DISPLAY_NAME: "RoonPresence",
  ROON_DISPLAY_VERSION: "0.1.0",
  LOG_LEVEL: "info",
  DEBUG_DISCORD_PAYLOAD: "false",
  MEMORY_LOG_MS: "300000",
  TIDAL_BUTTON_ENABLED: "true",
  TIDAL_BUTTON_LABEL: "Play on TIDAL",
  TIDAL_SEARCH_BASE_URL: "https://tidal.com/search?q=",
  TIDAL_ARTWORK_LOOKUP: "true",
  TIDAL_COUNTRY_CODE: "US",
  TIDAL_CLIENT_ID: "",
  TIDAL_CLIENT_SECRET: "",
  ALBUM_ART_PUBLIC_BASE_URL: "https://art.darthspader.com",
  ALBUM_ART_PROXY_PORT: "8787",
  ALBUM_ART_CACHE_MAX: "40",
  RADIO_METADATA_LOOKUP: "true",
  RADIO_METADATA_CACHE_MAX: "200",
  RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS: "1500",
  DISCOGS_LOOKUP: "true",
  DISCOGS_TOKEN: "",
  LASTFM_SCROBBLE_RADIO: "false",
  LASTFM_API_KEY: "",
  LASTFM_API_SECRET: "",
  LASTFM_SESSION_KEY: ""
};

const ORDER = Object.keys(DEFAULTS);

function clean(value) {
  return String(value || "").trim();
}

function loadExistingValues() {
  return {
    ...DEFAULTS,
    ...readDotEnvFile(ENV_EXAMPLE_PATH),
    ...readDotEnvFile(ENV_PATH)
  };
}

function isPlaceholder(value) {
  return /^your_|_here$/i.test(clean(value)) || clean(value) === "your_discord_application_client_id";
}

function maskSecret(value) {
  const text = clean(value);
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function serializeEnv(values) {
  return ORDER.map((key) => {
    const value = String(values[key] ?? "").replace(/[\r\n]/g, " ").trim();
    return `${key}=${value}`;
  }).join("\r\n") + "\r\n";
}

async function ask(rl, values, key, prompt, { required = false, secret = false } = {}) {
  while (true) {
    const current = values[key] || "";
    const shown = secret ? maskSecret(current) : current;
    const suffix = shown ? ` [${shown}]` : "";
    const answer = await rl.question(`${prompt}${suffix}: `);
    const next = answer.trim() ? answer.trim() : current;
    if (!required || (clean(next) && !isPlaceholder(next))) {
      values[key] = next;
      return;
    }
    console.log("This value is required. Placeholder values will not work.");
  }
}

async function askYesNo(rl, values, key, prompt) {
  const current = /^(1|true|yes)$/i.test(values[key] || "") ? "Y" : "n";
  while (true) {
    const answer = await rl.question(`${prompt} [${current}]: `);
    const next = clean(answer) || current;
    if (/^(y|yes|true|1)$/i.test(next)) {
      values[key] = "true";
      return true;
    }
    if (/^(n|no|false|0)$/i.test(next)) {
      values[key] = "false";
      return false;
    }
    console.log("Please answer yes or no.");
  }
}

async function main() {
  const values = loadExistingValues();
  const rl = readline.createInterface({ input, output });

  console.log("RoonPresence setup");
  console.log("This will create or update .env for this folder.");
  console.log("Press Enter to keep the value shown in brackets.\n");

  try {
    await ask(rl, values, "DISCORD_CLIENT_ID", "Discord application client ID", { required: true });
    await ask(rl, values, "DISCORD_DEFAULT_IMAGE_KEY", "Discord default image key");
    await ask(rl, values, "HQPLAYER_ZONE_MATCH", "Roon zone name to publish");
    await ask(rl, values, "HQPLAYER_RATE_COMMAND", "HQPlayer rate command");
    await ask(rl, values, "HQPLAYER_SIGNAL_PATH_PREFIX", "HQPlayer signal path fallback/prefix");
    await ask(rl, values, "ALBUM_ART_PUBLIC_BASE_URL", "Public album art URL");

    const useDiscogs = await askYesNo(rl, values, "DISCOGS_LOOKUP", "Enable Discogs artwork lookup?");
    if (useDiscogs) {
      await ask(rl, values, "DISCOGS_TOKEN", "Discogs personal access token", { secret: true });
    }

    const useTidal = await askYesNo(rl, values, "TIDAL_BUTTON_ENABLED", "Enable Play on TIDAL button?");
    if (useTidal) {
      await ask(rl, values, "TIDAL_BUTTON_LABEL", "TIDAL button label");
      await ask(rl, values, "TIDAL_SEARCH_BASE_URL", "TIDAL search base URL");
    }

    const useTidalArtwork = await askYesNo(rl, values, "TIDAL_ARTWORK_LOOKUP", "Use TIDAL for radio artwork?");
    if (useTidalArtwork) {
      await ask(rl, values, "TIDAL_COUNTRY_CODE", "TIDAL country code");
      await ask(rl, values, "TIDAL_CLIENT_ID", "TIDAL client ID (for artwork lookup)", { secret: true });
      await ask(rl, values, "TIDAL_CLIENT_SECRET", "TIDAL client secret (for artwork lookup)", { secret: true });
    }

    const useLastFm = await askYesNo(rl, values, "LASTFM_SCROBBLE_RADIO", "Scrobble parsed radio tracks to Last.fm?");
    if (useLastFm) {
      await ask(rl, values, "LASTFM_API_KEY", "Last.fm API key", { secret: true });
      await ask(rl, values, "LASTFM_API_SECRET", "Last.fm shared secret", { secret: true });
      await ask(rl, values, "LASTFM_SESSION_KEY", "Last.fm session key", { secret: true });
    }

    fs.writeFileSync(ENV_PATH, serializeEnv(values));
    console.log("\nSaved .env");
    console.log("\nNext steps:");
    console.log("1. Run: npm start");
    console.log("2. In Roon: Settings > Extensions > Enable RoonPresence");
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  ORDER,
  isPlaceholder,
  maskSecret,
  serializeEnv
};

