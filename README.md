# RoonPresence

Command-line MVP for publishing the active Roon HQPlayer zone to Discord Rich Presence.

## Quick Install (Windows)

1. Install Node.js LTS.
2. Download or clone RoonPresence.
3. Open the RoonPresence folder.
4. Run `RoonPresence.exe`.
5. In Roon, go to **Settings > Extensions** and enable **RoonPresence**.

The launcher installs dependencies if needed, runs guided setup if `.env` is missing, then starts RoonPresence.

## Manual CLI Install

Use this path if you want to run directly from PowerShell instead of the portable launcher:

```powershell
git clone https://github.com/darthspaders/RoonPresence.git
cd RoonPresence
npm install
npm run setup
npm start
```

## Getting API Keys

### Discord Client ID

RoonPresence needs a Discord application Client ID so Discord knows which Rich Presence app is publishing your status.

1. Open the Discord Developer Portal: https://discord.com/developers/applications
2. Click **New Application**.
3. Name it `RoonPresence`, then create it.
4. Open the app's **General Information** page.
5. Copy the **Application ID**. Discord also calls this the **Client ID**.
6. Paste it into setup when asked for `Discord application client ID`, or set it in `.env`:

```env
DISCORD_CLIENT_ID=your_application_id_here
```

Discord's own developer support notes that the Application ID, also known as the Client ID, is found in the Developer Portal under General Information: https://support-dev.discord.com/hc/en-us/articles/360028717192-Where-can-I-find-my-Application-Team-Server-ID

### Discogs Token

Discogs is optional, but recommended for better radio artwork lookup.

1. Sign in to Discogs: https://www.discogs.com
2. Open developer settings: https://www.discogs.com/settings/developers
3. Find **Personal Access Token**.
4. Generate or copy your token.
5. Paste it into setup when asked for `Discogs personal access token`, or set it in `.env`:

```env
DISCOGS_LOOKUP=true
DISCOGS_TOKEN=your_discogs_token_here
```

Keep this token private. Do not paste it into GitHub issues, screenshots, or commits. Discogs API usage is governed by their API terms: https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use

## Known Good `.env`

```env
DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_DEFAULT_IMAGE_KEY=roonpresence
HQPLAYER_ZONE_MATCH=HQPlayer
HQPLAYER_SIGNAL_PATH_STATIC=
HQPLAYER_SIGNAL_PATH_PREFIX=poly-sinc-gauss-hires-lp, PCM
HQPLAYER_SIGNAL_PATH_COMMAND=
HQPLAYER_STATUS_COMMAND=
HQPLAYER_RATE_COMMAND="C:\Program Files\Signalyst\HQPlayer 5 Desktop\hqp5-control.exe" localhost --state
HQPLAYER_SIGNAL_PATH_POLL_MS=60000
ROON_EXTENSION_ID=com.example.roon-discord-cli
ROON_DISPLAY_NAME=RoonPresence
ROON_DISPLAY_VERSION=0.1.0
LOG_LEVEL=info
DEBUG_DISCORD_PAYLOAD=false
MEMORY_LOG_MS=300000
TIDAL_BUTTON_ENABLED=true
TIDAL_BUTTON_LABEL=Play on TIDAL
TIDAL_SEARCH_BASE_URL=https://tidal.com/search?q=
TIDAL_ARTWORK_LOOKUP=true
TIDAL_COUNTRY_CODE=US
TIDAL_ACCESS_TOKEN=
ALBUM_ART_PUBLIC_BASE_URL=https://art.darthspader.com
ALBUM_ART_PROXY_PORT=8787
ALBUM_ART_CACHE_MAX=40
RADIO_METADATA_LOOKUP=true
RADIO_METADATA_CACHE_MAX=200
RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS=1500
DISCOGS_LOOKUP=true
DISCOGS_TOKEN=
LASTFM_SCROBBLE_RADIO=false
LASTFM_API_KEY=
LASTFM_API_SECRET=
LASTFM_SESSION_KEY=
```

## Guided Setup

Run the setup wizard any time you want to create or update `.env`:

```powershell
npm run setup
```

Existing values are shown in brackets. Press Enter to keep them.

## GitHub Setup Wizard

Build a setup wizard exe for GitHub Releases:

```powershell
npm run build:setup
```

The setup wizard is written to:

```text
dist\RoonPresenceSetup.exe
```

`RoonPresenceSetup.exe` downloads the latest GitHub zip, installs it to `%LOCALAPPDATA%\RoonPresence`, runs `npm install`, starts guided setup if `.env` is missing, and can create a desktop launcher.

## Portable Launcher

Build a local Windows launcher exe:

```powershell
npm run build:launcher
```

The launcher is written to:

```text
dist\RoonPresence.exe
```

Place or keep `RoonPresence.exe` in the RoonPresence project folder. When opened, it checks for Node.js/npm, installs dependencies if `node_modules` is missing, runs guided setup if `.env` is missing, then starts RoonPresence.

## Run

```powershell
npm start
```

The first run waits for Roon authorization. In Roon, go to **Settings > Extensions** and enable **RoonPresence**.

Expected startup lines include:

```text
INFO Startup health check ...
INFO Connected to Discord via discord-rpc
INFO Searching for Roon Core
INFO Paired with Roon Core: ...
INFO Using HQPlayer zone: HQPlayer
INFO HQPlayer signal path: ...
INFO Publishing Discord presence: ...
```

## TIDAL Button

RoonPresence can add a Discord button that opens a TIDAL search for the current artist and track:

```env
TIDAL_BUTTON_ENABLED=true
TIDAL_BUTTON_LABEL=Play on TIDAL
TIDAL_SEARCH_BASE_URL=https://tidal.com/search?q=
```

Set `TIDAL_BUTTON_ENABLED=false` if you do not want the button.

Discord only shows Rich Presence buttons to other users viewing your profile; you will not see your own TIDAL button on your own activity card.

## TIDAL Artwork

For live radio metadata, RoonPresence tries TIDAL artwork first, then Discogs, then MusicBrainz/Cover Art Archive. The TIDAL image URL is still sent through the album-art proxy before Discord receives it.

```env
TIDAL_ARTWORK_LOOKUP=true
TIDAL_COUNTRY_CODE=US
TIDAL_ACCESS_TOKEN=
```

`TIDAL_ACCESS_TOKEN` is optional. If TIDAL blocks unauthenticated lookup, paste a valid TIDAL access token there.

## Album Art

Roon album art lives on your local network, and Discord cannot load that private URL directly.

To show art in Discord, expose this CLI's album-art proxy with a public HTTPS URL, then set:

```env
ALBUM_ART_PUBLIC_BASE_URL=https://art.darthspader.com
ALBUM_ART_PROXY_PORT=8787
```

When this is not set, the app logs that album art was found but does not send the private Roon URL to Discord.

## Radio Metadata

For radio streams that only provide station artwork, RoonPresence can look up track artwork using the live artist/title text from Roon. TIDAL is tried first, Discogs is tried next when `DISCOGS_TOKEN` is set, then MusicBrainz and Cover Art Archive are used as fallback. Results are cached in memory and lookups are rate-limited by `RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS`.

If lookup fails or the stream only reports station text, RoonPresence uses `DISCORD_DEFAULT_IMAGE_KEY` so Discord shows the app artwork and can still display the station name as image text.

## Last.fm Radio Scrobbling

RoonPresence can scrobble radio tracks to Last.fm, but only when the radio metadata can be parsed into both artist and track title. Title-only radio mixes, station-only text, and local library tracks are not scrobbled.

```env
LASTFM_SCROBBLE_RADIO=true
LASTFM_API_KEY=your_lastfm_api_key
LASTFM_API_SECRET=your_lastfm_shared_secret
LASTFM_SESSION_KEY=your_lastfm_session_key
```

Last.fm `track.scrobble` requires an API key, shared secret, and authenticated session key: https://www.last.fm/api/show/track.scrobble

## Stability Checks

Use this quick pass after changes:

1. Start Discord before the CLI.
2. Start Roon and play a normal local track through the HQPlayer zone.
3. Confirm Discord shows album art, elapsed/total time, and HQPlayer signal path.
4. Switch PCM to SDM/DSD in HQPlayer and confirm the signal path updates.
5. Switch to DI.FM/radio and confirm there is no end time/progress total from the previous track.
6. Stop playback and confirm Discord clears.
7. Restart Discord while the CLI is running and confirm it reconnects.

## Troubleshooting

If the default app image appears instead of album art, check `ALBUM_ART_PUBLIC_BASE_URL`. Discord must be able to fetch that URL from the internet.

If Roon is stuck at startup, open **Settings > Extensions** in Roon and enable **RoonPresence**.

If HQPlayer sample rate does not update, confirm `HQPLAYER_RATE_COMMAND` points to `hqp5-control.exe` and includes `localhost --state`.

If memory grows unexpectedly, keep `MEMORY_LOG_MS=300000` and compare the periodic memory lines over a few hours.

## Test

```powershell
npm test
```

