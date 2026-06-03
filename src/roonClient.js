const EventEmitter = require("events");
const RoonApi = require("roon-api");
const RoonApiTransport = require("roon-api-transport");
const { makeZoneMatcher } = require("./zoneMatcher");

const SEEK_JUMP_TOLERANCE_SECONDS = 5;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function zoneContentSignature(zone) {
  const nowPlaying = zone?.now_playing || {};
  return JSON.stringify({
    zoneId: zone?.zone_id || "",
    zoneName: zone?.display_name || zone?.zone_name || "",
    state: zone?.state || "",
    title:
      nowPlaying?.three_line?.line1 ||
      nowPlaying?.two_line?.line1 ||
      nowPlaying?.one_line?.line1 ||
      nowPlaying?.title ||
      "",
    artist:
      nowPlaying?.three_line?.line2 ||
      nowPlaying?.two_line?.line2 ||
      nowPlaying?.artist ||
      "",
    album:
      nowPlaying?.three_line?.line3 ||
      nowPlaying?.album ||
      "",
    imageKey: nowPlaying?.image_key || "",
    length: nowPlaying?.length || "",
    isSeekAllowed: nowPlaying?.is_seek_allowed ?? zone?.is_seek_allowed ?? ""
  });
}

function isPrivateImageUrl(url) {
  return /^https?:\/\/(?:127\.|10\.|192\.168\.|localhost|172\.(?:1[6-9]|2\d|3[0-1])\.)/i.test(String(url || ""));
}

class RoonClient extends EventEmitter {
  constructor({ roonConfig, hqplayerZoneMatch, logger, clock = () => Date.now() }) {
    super();
    this.roonConfig = roonConfig;
    this.logger = logger;
    this.clock = clock;
    this.isHqPlayerZone = makeZoneMatcher(hqplayerZoneMatch);
    this.roon = null;
    this.core = null;
    this.transport = null;
    this.zones = new Map();
    this.activeZoneId = null;
    this.lastEmittedSignature = "";
    this.lastEmittedSeek = null;
    this.lastEmittedAt = 0;
  }

  start() {
    this.roon = new RoonApi({
      ...this.roonConfig,
      core_paired: (core) => this.onCorePaired(core),
      core_unpaired: (core) => this.onCoreUnpaired(core)
    });

    this.roon.init_services({
      required_services: [RoonApiTransport]
    });

    this.logger.info("Searching for Roon Core");
    this.roon.start_discovery();
  }

  onCorePaired(core) {
    this.core = core;
    this.transport = core.services.RoonApiTransport;
    this.logger.info(`Paired with Roon Core: ${core.display_name || core.core_id}`);

    this.transport.subscribe_zones((command, payload) => {
      try {
        this.onZones(command, payload);
      } catch (error) {
        this.logger.error("Failed to process Roon zone update", { error: error.message });
      }
    });
  }

  onCoreUnpaired(core) {
    this.logger.warn(`Unpaired from Roon Core: ${core.display_name || core.core_id}`);
    this.core = null;
    this.transport = null;
    this.zones.clear();
    this.activeZoneId = null;
    this.resetEmissionState();
    this.emit("inactive");
  }

  onZones(command, payload) {
    for (const zone of payload?.zones_removed || []) {
      this.zones.delete(zone.zone_id);
    }

    for (const zone of payload?.zones || []) {
      this.zones.set(zone.zone_id, zone);
    }

    for (const zone of payload?.zones_changed || []) {
      const previous = this.zones.get(zone.zone_id) || {};
      this.zones.set(zone.zone_id, {
        ...previous,
        ...zone,
        now_playing: {
          ...(previous.now_playing || {}),
          ...(zone.now_playing || {})
        },
        outputs: zone.outputs || previous.outputs || []
      });
    }

    for (const change of payload?.zones_seek_changed || []) {
      const previous = this.zones.get(change.zone_id);
      if (!previous) continue;
      this.zones.set(change.zone_id, {
        ...previous,
        seek_position: change.seek_position,
        now_playing: previous.now_playing
          ? {
              ...previous.now_playing,
              seek_position: change.seek_position
            }
          : previous.now_playing
      });
    }

    const candidates = [...this.zones.values()].filter((zone) => this.isHqPlayerZone(zone));
    const playing = candidates.find((zone) => zone.state === "playing");
    const selected = playing || candidates[0];

    if (!selected) {
      if (this.activeZoneId) this.logger.warn("No HQPlayer zone found");
      this.activeZoneId = null;
      this.resetEmissionState();
      this.emit("inactive");
      return;
    }

    if (selected.zone_id !== this.activeZoneId) {
      this.activeZoneId = selected.zone_id;
      this.logger.info(`Using HQPlayer zone: ${selected.display_name || selected.zone_id}`);
    }

    if (selected.state === "playing") {
      this.applyAlbumArtUrl(selected);
      if (this.shouldEmitPlaying(selected)) {
        this.emit("playing", selected);
      }
    } else {
      this.resetEmissionState();
      this.emit("inactive");
    }

    this.logger.debug("Processed Roon zone update", {
      command,
      zone: selected.display_name,
      state: selected.state
    });
  }

  shouldEmitPlaying(zone) {
    const signature = zoneContentSignature(zone);
    const seek = asNumber(zone?.now_playing?.seek_position ?? zone?.seek_position);
    const now = this.clock();

    if (signature !== this.lastEmittedSignature) {
      this.lastEmittedSignature = signature;
      this.lastEmittedSeek = seek;
      this.lastEmittedAt = now;
      return true;
    }

    if (this.isSeekJump(seek, now)) {
      this.lastEmittedSeek = seek;
      this.lastEmittedAt = now;
      return true;
    }

    return false;
  }

  isSeekJump(seek, now) {
    if (seek === null || this.lastEmittedSeek === null || !this.lastEmittedAt) return false;

    const elapsedSeconds = (now - this.lastEmittedAt) / 1000;
    const seekDelta = seek - this.lastEmittedSeek;
    return Math.abs(seekDelta - elapsedSeconds) > SEEK_JUMP_TOLERANCE_SECONDS;
  }

  resetEmissionState() {
    this.lastEmittedSignature = "";
    this.lastEmittedSeek = null;
    this.lastEmittedAt = 0;
  }

  applyAlbumArtUrl(zone) {
    const imageKey = zone?.now_playing?.image_key;
    if (!imageKey || !this.core?.moo?.transport?.host || !this.core?.moo?.transport?.port) return;

    const host = this.core.moo.transport.host;
    const port = this.core.moo.transport.port;
    const encodedKey = encodeURIComponent(imageKey);
    zone.now_playing.album_art_url =
      `http://${host}:${port}/api/image/${encodedKey}?scale=fill&width=512&height=512&format=image/jpeg`;

    this.logger.debug("Resolved Roon album art URL", {
      imageKey,
      url: zone.now_playing.album_art_url
    });
    if (isPrivateImageUrl(zone.now_playing.album_art_url)) {
      this.logger.debug("Roon album art URL is local/private; Discord may not render it directly");
    }
  }
}

module.exports = { RoonClient, zoneContentSignature, isPrivateImageUrl };
