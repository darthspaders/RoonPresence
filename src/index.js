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

function main() {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
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
    logger
  });
  const radioMetadataResolver = new RadioMetadataResolver({
    enabled: config.radioMetadata.enabled,
    cacheMax: config.radioMetadata.cacheMax,
    minLookupIntervalMs: config.radioMetadata.minLookupIntervalMs,
    discogsEnabled: config.radioMetadata.discogsEnabled,
    discogsToken: config.radioMetadata.discogsToken,
    logger
  });
  const publisher = new PresencePublisher({
    discord,
    mapper,
    logger,
    signalPathProvider: hqplayerStatus,
    albumArtProvider: albumArtProxy,
    radioMetadataResolver,
    defaultImageKey: config.discordDefaultImageKey,
    debugPayload: config.debugDiscordPayload
  });
  const roon = new RoonClient({
    roonConfig: config.roon,
    hqplayerZoneMatch: config.hqplayerZoneMatch,
    logger
  });
  const memoryMonitor = createMemoryMonitor({
    logger,
    intervalMs: config.memoryLogMs
  });

  health.logStartup();

  roon.on("playing", (zone) => {
    health.update("roon", "playing", {
      zone: zone.display_name || zone.zone_id
    });
    health.update("hqplayer", "active");
    hqplayerStatus.start();
    publisher.publishZone(zone);
  });

  hqplayerStatus.on("signalPathChanged", () => {
    health.update("hqplayer", "signal-ready", {
      signalPath: hqplayerStatus.getSignalPath()
    });
    logger.info("HQPlayer signal path changed; refreshing Discord presence");
    publisher.republishLast();
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
          cacheMax: freshConfig.albumArt.cacheMax
        });
        const radioMetadataChanged = radioMetadataResolver.updateConfig({
          enabled: freshConfig.radioMetadata.enabled,
          cacheMax: freshConfig.radioMetadata.cacheMax,
          minLookupIntervalMs: freshConfig.radioMetadata.minLookupIntervalMs,
          discogsEnabled: freshConfig.radioMetadata.discogsEnabled,
          discogsToken: freshConfig.radioMetadata.discogsToken
        });
        if (changed || albumArtChanged || radioMetadataChanged) {
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
    health.update("hqplayer", "idle");
    logger.info("Clearing Discord presence");
    hqplayerStatus.stop();
    publisher.clear();
  });

  discord.start();
  memoryMonitor.start();
  if (!albumArtProxy.start()) albumArtProxy.warnIfDisabled();
  health.snapshot();
  roon.start();

  process.on("SIGINT", () => {
    logger.info("Shutting down");
    memoryMonitor.stop();
    hqplayerStatus.stop();
    albumArtProxy.stop();
    radioMetadataResolver.stop();
    publisher.clear();
    discord.stop();
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

