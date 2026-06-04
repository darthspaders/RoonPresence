# RoonPresence

Command-line MVP for publishing the active Roon HQPlayer zone to Discord Rich Presence.

## Quick Install (Windows)

1. Install Node.js LTS.
2. Open PowerShell.
3. Run:

```powershell
git clone https://github.com/darthspaders/RoonPresence.git
cd RoonPresence
npm install
Copy-Item .env.example .env
notepad .env
npm start
```

4. In Roon, go to **Settings > Extensions** and enable **RoonPresence**.

This creates your personal `.env` config file. Set `DISCORD_CLIENT_ID` in `.env` before starting the app.

## Known Good `.env`

```env
DISCORD_CLIENT_ID=your_discord_application_client_id
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
ALBUM_ART_PUBLIC_BASE_URL=https://art.darthspader.com
ALBUM_ART_PROXY_PORT=8787
ALBUM_ART_CACHE_MAX=40
RADIO_METADATA_LOOKUP=true
RADIO_METADATA_CACHE_MAX=200
RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS=1500
```

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

## Album Art

Roon album art lives on your local network, and Discord cannot load that private URL directly.

To show art in Discord, expose this CLI's album-art proxy with a public HTTPS URL, then set:

```env
ALBUM_ART_PUBLIC_BASE_URL=https://art.darthspader.com
ALBUM_ART_PROXY_PORT=8787
```

When this is not set, the app logs that album art was found but does not send the private Roon URL to Discord.

## Radio Metadata

For radio streams that only provide station artwork, RoonPresence can look up track artwork from MusicBrainz and Cover Art Archive using the live artist/title text from Roon. Results are cached in memory and lookups are rate-limited by `RADIO_METADATA_MIN_LOOKUP_INTERVAL_MS`.

If lookup fails or the stream only reports station text, RoonPresence omits the station image so Discord falls back to the app artwork instead of showing stale radio art.

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
