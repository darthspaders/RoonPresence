function yesNo(value) {
  return value ? "yes" : "no";
}

class HealthStatus {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.state = {
      discord: "starting",
      roon: "searching",
      hqplayer: "idle",
      albumArt: config.albumArt.publicBaseUrl ? "configured" : "disabled",
      memory: config.memoryLogMs > 0 ? "enabled" : "disabled"
    };
  }

  logStartup() {
    this.logger.info("Startup health check", {
      discordClientId: this.config.discordClientId ? "set" : "missing",
      roonExtension: this.config.roon.display_name,
      hqplayerZoneMatch: this.config.hqplayerZoneMatch,
      hqplayerRateCommand: yesNo(this.config.hqplayer.rateCommand),
      hqplayerStatusCommand: yesNo(this.config.hqplayer.statusCommand),
      hqplayerStaticPath: yesNo(this.config.hqplayer.signalPathStatic),
      albumArtPublicUrl: yesNo(this.config.albumArt.publicBaseUrl),
      albumArtProxyPort: this.config.albumArt.proxyPort,
      memoryLogMs: this.config.memoryLogMs
    });
  }

  update(name, status, meta) {
    if (this.state[name] === status && !meta) return;
    this.state[name] = status;
    this.logger.info(`Health: ${name} ${status}`, meta);
  }

  snapshot() {
    this.logger.info("Health snapshot", this.state);
  }
}

module.exports = { HealthStatus };
