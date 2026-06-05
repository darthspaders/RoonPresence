const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { createApiSignature } = require("../src/lastFmScrobbler");

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

function clean(value) {
  return String(value || "").trim();
}

async function parseJsonResponse(response) {
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

async function requestJson(params) {
  const url = new URL(API_ROOT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  return parseJsonResponse(await fetch(url));
}

async function postJson(params) {
  const body = new URLSearchParams(params);
  return parseJsonResponse(await fetch(API_ROOT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  }));
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
function updateEnvValues(values, envPath = path.resolve(process.cwd(), ".env")) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${String(values[match[1]] || "").replace(/[\r\n]/g, " ").trim()}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${String(value || "").replace(/[\r\n]/g, " ").trim()}`);
    }
  }

  fs.writeFileSync(envPath, nextLines.join("\r\n").replace(/(?:\r\n)*$/, "\r\n"));
}

function printSessionKey(sessionJson, { apiKey, apiSecret } = {}) {
  const sessionKey = clean(sessionJson.session?.key);
  if (!sessionKey) throw new Error("Last.fm did not return a session key.");

  updateEnvValues({
    LASTFM_SCROBBLE_RADIO: "true",
    LASTFM_API_KEY: apiKey,
    LASTFM_API_SECRET: apiSecret,
    LASTFM_SESSION_KEY: sessionKey
  });

  console.log("\nSuccess. Saved Last.fm settings to .env:");
  console.log("LASTFM_SCROBBLE_RADIO=true");
  console.log(`LASTFM_API_KEY=${apiKey}`);
  console.log("LASTFM_API_SECRET=********");
  console.log(`LASTFM_SESSION_KEY=${sessionKey}`);
}

async function desktopAuth(rl, apiKey, apiSecret) {
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

  const authUrl = `https://www.last.fm/api/auth?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
  console.log("\nOpening Last.fm authorization page...");
  console.log(authUrl);
  console.log("\nIf Last.fm shows 'Invalid API key' after you approve, edit your Last.fm API app and set a Callback URL such as http://localhost/.");
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
  printSessionKey(await requestJson(sessionParams), { apiKey, apiSecret });
}

async function mobileAuth(rl, apiKey, apiSecret) {
  console.log("\nMobile auth fallback. This sends your Last.fm username/password directly to Last.fm over HTTPS.");
  console.log("Use this only on your own machine. The password is not saved by RoonPresence.\n");

  const username = clean(await rl.question("Last.fm username or email: "));
  const password = await rl.question("Last.fm password: ");
  if (!username || !password) throw new Error("Username and password are required for mobile auth.");

  const params = {
    method: "auth.getMobileSession",
    username,
    password,
    api_key: apiKey,
    format: "json"
  };
  params.api_sig = createApiSignature(params, apiSecret);

  console.log("\nRequesting session key...");
  printSessionKey(await postJson(params), { apiKey, apiSecret });
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const useMobile = process.argv.includes("--mobile");
    console.log(useMobile ? "Last.fm mobile session helper" : "Last.fm session key helper");
    console.log("Paste your Last.fm API key and shared secret. A successful session will be saved to .env.\n");

    const apiKey = clean(await rl.question("Last.fm API key: "));
    const apiSecret = clean(await rl.question("Last.fm shared secret: "));
    if (!apiKey || !apiSecret) throw new Error("API key and shared secret are required.");

    console.log(`\nAPI key length: ${apiKey.length} characters`);
    if (apiKey.length !== 32) {
      console.log("Heads up: Last.fm API keys are normally 32 characters. If this is not 32, it was probably copied wrong.");
    }

    if (useMobile) {
      await mobileAuth(rl, apiKey, apiSecret);
    } else {
      await desktopAuth(rl, apiKey, apiSecret);
    }
  } catch (error) {
    console.error(`\nFailed: ${error.message}`);
    console.error("\nChecks:");
    console.error("- Confirm the API key is exactly the API Key, not the shared secret.");
    console.error("- Confirm there are no leading/trailing spaces when you paste it.");
    console.error("- In your Last.fm API app settings, set Callback URL to http://localhost/ and save.");
    console.error("- If browser auth still fails, run: npm run lastfm:mobile-auth");
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { requestJson, postJson, updateEnvValues };

