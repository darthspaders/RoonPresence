const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 10_000;
const DEFAULT_START_ROUNDING_MS = 15_000;

function roundTimestamp(value, nearestMs) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value / nearestMs) * nearestMs;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanText(value).toLowerCase();
}

class PresencePublisher {
  constructor({
    discord,
    mapper,
    logger,
    signalPathProvider,
    albumArtProvider,
    radioMetadataResolver,
    clock = () => Date.now(),
    minPublishIntervalMs = DEFAULT_MIN_PUBLISH_INTERVAL_MS,
    startRoundingMs = DEFAULT_START_ROUNDING_MS,
    debugPayload = false
  }) {
    this.discord = discord;
    this.mapper = mapper;
    this.logger = logger;
    this.signalPathProvider = signalPathProvider;
    this.albumArtProvider = albumArtProvider;
    this.radioMetadataResolver = radioMetadataResolver;
    this.clock = clock;
    this.minPublishIntervalMs = minPublishIntervalMs;
    this.startRoundingMs = startRoundingMs;
    this.lastPublishedSignature = "";
    this.lastPublishedIdentitySignature = "";
    this.lastPublishedAt = 0;
    this.lastZone = null;
    this.lastSkipLogAt = 0;
    this.debugPayload = debugPayload;
    this.lastAlbumArtWarningKey = "";
  }

  publishZone(zone) {
    this.lastZone = zone;
    const presence = this.mapper.mapPresence(zone);
    if (!presence) return false;
    this.radioMetadataResolver?.apply?.(presence);
    this.applyExternalSignalPath(presence);

    const signature = this.createSignature(presence);
    const identitySignature = this.createIdentitySignature(presence);
    if (signature === this.lastPublishedSignature) {
      this.logUnchangedSkip();
      return false;
    }

    const identityChanged = identitySignature !== this.lastPublishedIdentitySignature;
    if (!identityChanged && this.isThrottled()) {
      this.logUnchangedSkip();
      return false;
    }

    this.lastPublishedSignature = signature;
    this.lastPublishedIdentitySignature = identitySignature;
    this.lastPublishedAt = this.clock();
    this.logger.info(
      `Publishing Discord presence: ${presence.activity.details} - ${presence.activity.state}`
    );
    const rpcActivity = this.toDiscordRpcActivity(presence);
    if (this.debugPayload) {
      console.log("[DISCORD PAYLOAD]", JSON.stringify(rpcActivity, null, 2));
    }
    this.discord.setActivity(rpcActivity);
    return true;
  }

  republishLast() {
    if (!this.lastZone) {
      this.logger.info("No active Roon zone yet; skipping Discord refresh");
      return false;
    }

    return this.publishZone(this.lastZone);
  }

  clear() {
    this.lastPublishedSignature = "";
    this.lastPublishedIdentitySignature = "";
    this.lastPublishedAt = 0;
    this.lastZone = null;
    this.lastSkipLogAt = 0;
    this.discord.clearActivity();
  }

  isThrottled() {
    return (
      this.lastPublishedAt > 0 &&
      this.clock() - this.lastPublishedAt < this.minPublishIntervalMs
    );
  }

  createSignature(presence) {
    const timestamps = presence.activity.timestamps || {};
    const start = roundTimestamp(timestamps.start, this.startRoundingMs);
    const duration =
      Number.isFinite(timestamps.start) && Number.isFinite(timestamps.end)
        ? Math.round(timestamps.end - timestamps.start)
        : null;
    const end = start !== null && duration !== null ? start + duration : null;

    return JSON.stringify({
      ...this.signatureParts(presence),
      startTimestamp: start,
      endTimestamp: end
    });
  }

  createIdentitySignature(presence) {
    return JSON.stringify(this.signatureParts(presence));
  }

  applyExternalSignalPath(presence) {
    const signalPath = this.signalPathProvider?.getSignalPath?.();
    if (!signalPath) return;

    presence.metadata.signalPath = signalPath;
    presence.activity.details = `${presence.metadata.title} - ${presence.metadata.artist}`.slice(0, 128);
    presence.activity.state = signalPath.slice(0, 128);
  }

  toDiscordRpcActivity(presence) {
    const { activity } = presence;
    const rpcActivity = {
      type: 2,
      details: activity.details,
      state: activity.state,
      instance: !!activity.instance
    };
    const timestamps = activity.timestamps || {};

    if (Number.isFinite(timestamps.start)) {
      rpcActivity.startTimestamp = timestamps.start;
    }

    if (presence.timestampMode === "LOCAL" && Number.isFinite(timestamps.end)) {
      rpcActivity.endTimestamp = timestamps.end;
    }

    if (presence.timestampMode !== "LOCAL") {
      delete rpcActivity.endTimestamp;
    }

    const albumArtUrl = this.resolveAlbumArtUrl(presence);
    if (albumArtUrl) {
      rpcActivity.largeImageKey = albumArtUrl;
      const largeImageText = this.createLargeImageText(presence);
      if (largeImageText) rpcActivity.largeImageText = largeImageText;
    }

    return rpcActivity;
  }

  createLargeImageText(presence) {
    if (presence.timestampMode === "RADIO") {
      return cleanText(presence.metadata?.radioStationName).slice(0, 128);
    }

    const album = cleanText(presence.metadata?.album);
    const title = normalizeText(presence.metadata?.title);
    const artist = normalizeText(presence.metadata?.artist);
    const albumKey = normalizeText(album);
    if (!album || albumKey === title || albumKey === artist) return "";

    return album.slice(0, 128);
  }

  resolveAlbumArtUrl(presence) {
    const sourceUrl = presence.metadata?.albumArtUrl;
    if (!sourceUrl) return "";

    if (presence.timestampMode === "RADIO") {
      const albumArtKey = presence.metadata?.albumArtKey || "";
      const radioTrackKey = presence.metadata?.radioTrackKey || "";
      if (!albumArtKey.startsWith("radio:") || albumArtKey !== `radio:${radioTrackKey}`) {
        return "";
      }
    }

    const publicUrl = this.albumArtProvider?.getPublicUrl?.(
      sourceUrl,
      presence.metadata?.albumArtKey || ""
    );
    if (publicUrl) return publicUrl;

    const warningKey = `${presence.metadata?.albumArtKey || ""}|${sourceUrl}`;
    if (warningKey !== this.lastAlbumArtWarningKey) {
      this.lastAlbumArtWarningKey = warningKey;
      this.logger.info(
        "Album art found, but not sent to Discord. Set ALBUM_ART_PUBLIC_BASE_URL to a public HTTPS URL for this CLI."
      );
    }
    return "";
  }

  signatureParts(presence) {
    return {
      title: presence.metadata.title,
      artist: presence.metadata.artist,
      album: presence.metadata.album,
      zoneName: presence.metadata.zoneName,
      timestampMode: presence.timestampMode,
      signalPath: presence.metadata.signalPath || "",
      albumArtKey: presence.metadata.albumArtKey || "",
      albumArtUrl: presence.metadata.albumArtUrl || "",
      radioTrackKey: presence.metadata.radioTrackKey || "",
      radioArtworkResolved: !!presence.metadata.radioArtworkResolved
    };
  }

  logUnchangedSkip() {
    const now = this.clock();
    if (this.lastSkipLogAt > 0 && now - this.lastSkipLogAt < this.minPublishIntervalMs) return;

    this.lastSkipLogAt = now;
    this.logger.info("Presence unchanged; skipping publish");
  }
}

module.exports = {
  PresencePublisher,
  DEFAULT_MIN_PUBLISH_INTERVAL_MS,
  DEFAULT_START_ROUNDING_MS
};
