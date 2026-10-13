const fs = require("fs");
const path = require("path");
const { readConfig, readConfigFresh } = require("./env");
const { createLogger } = require("./log");
const { DiscordRpcClient } = require("./discordRpc");
const { PresenceMapper } = require("./presenceMapper");
const { PresencePublisher } = require("./presencePublisher");
const { RoonClient } = require("./roonClient");
const { HQPlayerStatusProvider } = require("./hqplayerStatus");
const { createMemoryMonitor } = require("./memoryMonitor");
const { AlbumArtProxy } = require("./albumArtProxy");
const { HealthStatus } = require("./healthStatus");
const { RadioMetadataResolver } = require("./radioMetadataResolver");
const { LastFmScrobbler } = require("./lastFmScrobbler");
const { acquireSingleInstanceLock } = require("./singleInstance");
const { LyrionPresence, mapLyrionPresence } = require("./lyrionPresence");

function main() {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  const releaseSingleInstanceLock = acquireSingleInstanceLock({ logger });
  if (!releaseSingleInstanceLock) {
    process.exitCode = 1;
    return;
  }
  process.once("exit", releaseSingleInstanceLock);

  const lastFmCachePath = path.join(__dirname, "..", ".lastfm-scrobble-cache.json");
  const health = new HealthStatus({ logger, config });

  if (!config.discordClientId) {
    logger.error("DISCORD_CLIENT_ID is missing. Copy .env.example to .env and set it.");
    process.exitCode = 1;
    return;
  }

  const discord = new DiscordRpcClient({
    clientId: config.discordClientId,
    logger
  });
  const mapper = new PresenceMapper();
  const mapRoonPresence = mapper.mapPresence.bind(mapper);
  mapper.mapPresence = zone => zone?.frontend === "lyrion" ? mapLyrionPresence(zone) : mapRoonPresence(zone);
  const hqplayerStatus = new HQPlayerStatusProvider({
    command: config.hqplayer.signalPathCommand,
    staticSignalPath: config.hqplayer.signalPathStatic,
    signalPathPrefix: config.hqplayer.signalPathPrefix,
    statusCommand: config.hqplayer.statusCommand,
    rateCommand: config.hqplayer.rateCommand,
    pollMs: config.hqplayer.pollMs,
    logger
  });
  const albumArtProxy = new AlbumArtProxy({
    publicBaseUrl: config.albumArt.publicBaseUrl,
    port: config.albumArt.proxyPort,
    cacheMax: config.albumArt.cacheMax,
    logger,
    persistNowPlaying: true,
    bridgeUsername: config.albumArt.bridgeUsername,
    bridgeBrandName: config.albumArt.bridgeBrandName,
    rabbitHoleBaseUrl: config.radioMetadata.rabbitHoleBaseUrl
  });
  albumArtProxy.setDebugStateProvider(() => discord.getDebugState());
  const radioMetadataResolver = new RadioMetadataResolver({
    enabled: config.radioMetadata.enabled,
    cacheMax: config.radioMetadata.cacheMax,
    minLookupIntervalMs: config.radioMetadata.minLookupIntervalMs,
    rabbitHoleArtworkEnabled: config.radioMetadata.rabbitHoleArtworkEnabled,
    rabbitHoleBaseUrl: config.radioMetadata.rabbitHoleBaseUrl,
    rabbitHoleTimeoutMs: config.radioMetadata.rabbitHoleTimeoutMs,
    rabbitHoleRetryDelayMs: config.radioMetadata.rabbitHoleRetryDelayMs,
    rabbitHolePollIntervalMs: config.radioMetadata.rabbitHolePollIntervalMs,
    rabbitHoleMaxWaitMs: config.radioMetadata.rabbitHoleMaxWaitMs,
    spotifyArtworkEnabled: config.radioMetadata.spotifyArtworkEnabled,
    spotifyMarket: config.radioMetadata.spotifyMarket,
    spotifyClientId: config.radioMetadata.spotifyClientId,
    spotifyClientSecret: config.radioMetadata.spotifyClientSecret,
    tidalArtworkEnabled: config.radioMetadata.tidalArtworkEnabled,
    tidalCountryCode: config.radioMetadata.tidalCountryCode,
    tidalAccessToken: config.radioMetadata.tidalAccessToken,
    tidalClientId: config.radioMetadata.tidalClientId,
    tidalClientSecret: config.radioMetadata.tidalClientSecret,
    discogsEnabled: config.radioMetadata.discogsEnabled,
    discogsToken: config.radioMetadata.discogsToken,
    albumArtProvider: albumArtProxy,
    logger
  });
  const scrobbler = new LastFmScrobbler({
    enabled: config.lastFm.enabled,
    apiKey: config.lastFm.apiKey,
    apiSecret: config.lastFm.apiSecret,
    sessionKey: config.lastFm.sessionKey,
    scrobbleCooldownMs: config.lastFm.scrobbleCooldownMs,
    scrobbleCachePath: lastFmCachePath,
    logger
  });
  const publisher = new PresencePublisher({
    discord,
    mapper,
    logger,
    signalPathProvider: hqplayerStatus,
    albumArtProvider: albumArtProxy,
    radioMetadataResolver,
    scrobbler,
    defaultImageKey: config.discordDefaultImageKey,
    tidalButton: config.tidalButton,
    debugPayload: config.debugDiscordPayload
  });
  const lyrionPresence = new LyrionPresence({
    baseUrl: process.env.LYRION_RABBIT_HOLE_URL || config.radioMetadata.rabbitHoleBaseUrl || "http://127.0.0.1:3777",
    publisher, signalPathProvider: hqplayerStatus
  });
  const roon = new RoonClient({
    roonConfig: config.roon,
    hqplayerZoneMatch: config.hqplayerZoneMatch,
    fallbackZoneMatch: config.roonFallbackZoneMatch,
    logger
  });
  const memoryMonitor = createMemoryMonitor({
    logger,
    intervalMs: config.memoryLogMs
  });

  health.logStartup();
  let hqplayerRepublishTimer = null;

  roon.on("playing", (zone) => {
    health.update("roon", "playing", {
      zone: zone.display_name || zone.zone_id
    });
    health.update("hqplayer", "active");
    hqplayerStatus.setPlaybackActive(true);
    hqplayerStatus.start();
    lyrionPresence.roonPlaying(zone);
  });

  hqplayerStatus.on("signalPathChanged", () => {
    health.update("hqplayer", "signal-ready", {
      signalPath: hqplayerStatus.getSignalPath()
    });
    if (hqplayerRepublishTimer) clearTimeout(hqplayerRepublishTimer);
    hqplayerRepublishTimer = setTimeout(() => {
      hqplayerRepublishTimer = null;
      logger.info("HQPlayer signal path changed; refreshing Discord presence");
      publisher.republishLast();
    }, 1000);
  });

  discord.on("connected", () => {
    health.update("discord", "connected");
    publisher.republishLast();
  });

  discord.on("disconnected", () => {
    health.update("discord", "disconnected");
  });

  radioMetadataResolver.on("metadataResolved", () => {
    logger.info("Radio metadata resolved; refreshing Discord presence");
    publisher.republishLast();
  });

  const envPath = path.resolve(process.cwd(), ".env");
  let envReloadTimer = null;
  if (fs.existsSync(envPath)) {
    fs.watch(envPath, () => {
      if (envReloadTimer) clearTimeout(envReloadTimer);
      envReloadTimer = setTimeout(() => {
        const freshConfig = readConfigFresh();
        const changed = hqplayerStatus.updateConfig({
          command: freshConfig.hqplayer.signalPathCommand,
          staticSignalPath: freshConfig.hqplayer.signalPathStatic,
          signalPathPrefix: freshConfig.hqplayer.signalPathPrefix,
          statusCommand: freshConfig.hqplayer.statusCommand,
          rateCommand: freshConfig.hqplayer.rateCommand,
          pollMs: freshConfig.hqplayer.pollMs
        });
        const albumArtChanged = albumArtProxy.updateConfig({
          publicBaseUrl: freshConfig.albumArt.publicBaseUrl,
          port: freshConfig.albumArt.proxyPort,
          cacheMax: freshConfig.albumArt.cacheMax,
          rabbitHoleBaseUrl: freshConfig.radioMetadata.rabbitHoleBaseUrl
        });
        const radioMetadataChanged = radioMetadataResolver.updateConfig({
          enabled: freshConfig.radioMetadata.enabled,
          cacheMax: freshConfig.radioMetadata.cacheMax,
          minLookupIntervalMs: freshConfig.radioMetadata.minLookupIntervalMs,
          rabbitHoleArtworkEnabled: freshConfig.radioMetadata.rabbitHoleArtworkEnabled,
          rabbitHoleBaseUrl: freshConfig.radioMetadata.rabbitHoleBaseUrl,
          rabbitHoleTimeoutMs: freshConfig.radioMetadata.rabbitHoleTimeoutMs,
          rabbitHoleRetryDelayMs: freshConfig.radioMetadata.rabbitHoleRetryDelayMs,
          rabbitHolePollIntervalMs: freshConfig.radioMetadata.rabbitHolePollIntervalMs,
          rabbitHoleMaxWaitMs: freshConfig.radioMetadata.rabbitHoleMaxWaitMs,
          spotifyArtworkEnabled: freshConfig.radioMetadata.spotifyArtworkEnabled,
          spotifyMarket: freshConfig.radioMetadata.spotifyMarket,
          spotifyClientId: freshConfig.radioMetadata.spotifyClientId,
          spotifyClientSecret: freshConfig.radioMetadata.spotifyClientSecret,
          tidalArtworkEnabled: freshConfig.radioMetadata.tidalArtworkEnabled,
          tidalCountryCode: freshConfig.radioMetadata.tidalCountryCode,
          tidalAccessToken: freshConfig.radioMetadata.tidalAccessToken,
          tidalClientId: freshConfig.radioMetadata.tidalClientId,
          tidalClientSecret: freshConfig.radioMetadata.tidalClientSecret,
          discogsEnabled: freshConfig.radioMetadata.discogsEnabled,
          discogsToken: freshConfig.radioMetadata.discogsToken
        });
        const scrobblerChanged = scrobbler.updateConfig({
          enabled: freshConfig.lastFm.enabled,
          apiKey: freshConfig.lastFm.apiKey,
          apiSecret: freshConfig.lastFm.apiSecret,
          sessionKey: freshConfig.lastFm.sessionKey,
          scrobbleCooldownMs: freshConfig.lastFm.scrobbleCooldownMs,
          scrobbleCachePath: lastFmCachePath
        });
        const publisherChanged = publisher.updateConfig({
          tidalButton: freshConfig.tidalButton
        });
        if (changed || albumArtChanged || radioMetadataChanged || scrobblerChanged || publisherChanged) {
          logger.info("Reloaded settings from .env");
          health.update(
            "albumArt",
            freshConfig.albumArt.publicBaseUrl ? "configured" : "disabled"
          );
          publisher.republishLast();
        }
      }, 250);
    });
  }

  roon.on("inactive", () => {
    health.update("roon", "inactive");
    if (lyrionPresence.roonInactive()) return;
    health.update("hqplayer", "idle");
    hqplayerStatus.setPlaybackActive(false);
    logger.info("Clearing Discord presence");
    if (hqplayerRepublishTimer) {
      clearTimeout(hqplayerRepublishTimer);
      hqplayerRepublishTimer = null;
    }
    hqplayerStatus.stop();
    publisher.clear();
  });

  discord.start();
  memoryMonitor.start();
  if (!albumArtProxy.start()) albumArtProxy.warnIfDisabled();
  health.snapshot();
  roon.start();
  lyrionPresence.start();

  process.on("SIGINT", () => {
    logger.info("Shutting down");
    if (hqplayerRepublishTimer) clearTimeout(hqplayerRepublishTimer);
    memoryMonitor.stop();
    lyrionPresence.stop();
    hqplayerStatus.stop();
    albumArtProxy.stop();
    radioMetadataResolver.stop();
    publisher.clear();
    discord.stop();
    releaseSingleInstanceLock();
    setTimeout(() => process.exit(0), 250);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Unexpected crash", { error: error.stack || error.message });
    process.exitCode = 1;
  });

  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled async error", {
      error: error?.stack || error?.message || String(error)
    });
  });
}

main();

