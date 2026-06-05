const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { createApiSignature } = require("../src/lastFmScrobbler");

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

function clean(value) {
  return String(value || "").trim();
}

async function requestJson(params) {
  const url = new URL(API_ROOT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Last.fm returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  if (!response.ok || json.error) {
    const message = json.message || response.statusText || "Last.fm request failed";
    throw new Error(`Last.fm error ${json.error || response.status}: ${message}`);
  }

  return json;
}

function openUrl(url) {
  const platform = process.platform;
  const { spawn } = require("child_process");
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("Last.fm session key helper");
    console.log("Paste your Last.fm API key and shared secret. They are not saved by this helper.\n");

    const apiKey = clean(await rl.question("Last.fm API key: "));
    const apiSecret = clean(await rl.question("Last.fm shared secret: "));
    if (!apiKey || !apiSecret) throw new Error("API key and shared secret are required.");

    const tokenParams = {
      method: "auth.getToken",
      api_key: apiKey,
      format: "json"
    };
    tokenParams.api_sig = createApiSignature(tokenParams, apiSecret);

    console.log("\nRequesting Last.fm auth token...");
    const tokenJson = await requestJson(tokenParams);
    const token = clean(tokenJson.token);
    if (!token) throw new Error("Last.fm did not return an auth token.");

    const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
    console.log("\nOpening Last.fm authorization page...");
    console.log(authUrl);
    openUrl(authUrl);

    await rl.question("\nApprove the app in your browser, then press Enter here: ");

    const sessionParams = {
      method: "auth.getSession",
      api_key: apiKey,
      token,
      format: "json"
    };
    sessionParams.api_sig = createApiSignature(sessionParams, apiSecret);

    console.log("\nRequesting session key...");
    const sessionJson = await requestJson(sessionParams);
    const sessionKey = clean(sessionJson.session?.key);
    if (!sessionKey) throw new Error("Last.fm did not return a session key.");

    console.log("\nSuccess. Put this in .env:");
    console.log(`LASTFM_SESSION_KEY=${sessionKey}`);
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nFailed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { requestJson };
