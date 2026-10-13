const EventEmitter = require("events");
const RoonApi = require("roon-api");
const RoonApiTransport = require("roon-api-transport");
const { makeZoneMatcher } = require("./zoneMatcher");

const SEEK_JUMP_TOLERANCE_SECONDS = 5;
const STATE_UPDATE_DEBOUNCE_MS = 1000;
const NOW_PLAYING_MIN_EMIT_MS = 2000;

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

function isPlayingZone(zone) {
  return zone?.state === "playing" && Boolean(zone?.now_playing);
}

function getRoonImageEndpoint(core) {
  const host = core?.moo?.transport?.host || "127.0.0.1";
  const port = core?.moo?.transport?.port || core?.registration?.http_port || null;
  if (!port) return null;
  return { host, port };
}

class RoonClient extends EventEmitter {
  constructor({ roonConfig, hqplayerZoneMatch, fallbackZoneMatch = "System Output", logger, clock = () => Date.now() }) {
    super();
    this.roonConfig = roonConfig;
    this.logger = logger;
    this.clock = clock;
    this.isHqPlayerZone = makeZoneMatcher(hqplayerZoneMatch);
    this.isFallbackZone = makeZoneMatcher(fallbackZoneMatch);
    this.roon = null;
    this.core = null;
    this.transport = null;
    this.zones = new Map();
    this.activeZoneId = null;
    this.activeZoneSelectionMode = "";
    this.lastEmittedSignature = "";
    this.lastEmittedSeek = null;
    this.lastEmittedAt = 0;
    this.zoneEvaluationTimer = null;
    this.pendingCommand = "";
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
    this.activeZoneSelectionMode = "";
    this.clearZoneEvaluationTimer();
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

    this.scheduleActiveZoneEvaluation(command);
  }

  scheduleActiveZoneEvaluation(command) {
    this.pendingCommand = command || this.pendingCommand;
    if (this.zoneEvaluationTimer) return;

    this.zoneEvaluationTimer = setTimeout(() => {
      const pendingCommand = this.pendingCommand;
      this.pendingCommand = "";
      this.zoneEvaluationTimer = null;
      this.evaluateActiveZone(pendingCommand);
    }, STATE_UPDATE_DEBOUNCE_MS);
  }

  clearZoneEvaluationTimer() {
    if (this.zoneEvaluationTimer) clearTimeout(this.zoneEvaluationTimer);
    this.zoneEvaluationTimer = null;
    this.pendingCommand = "";
  }

  selectActiveZone() {
    const zones = [...this.zones.values()];
    const hqplayerCandidates = zones.filter((zone) => this.isHqPlayerZone(zone));
    const fallbackCandidates = zones.filter((zone) => this.isFallbackZone(zone));
    const activeZone = this.activeZoneId ? this.zones.get(this.activeZoneId) : null;

    if (activeZone && this.isHqPlayerZone(activeZone) && isPlayingZone(activeZone)) {
      return { zone: activeZone, mode: "hqplayer" };
    }

    const playingHqplayer = hqplayerCandidates.find(isPlayingZone);
    if (playingHqplayer) return { zone: playingHqplayer, mode: "hqplayer" };

    if (activeZone && this.isFallbackZone(activeZone) && isPlayingZone(activeZone)) {
      return { zone: activeZone, mode: "fallback" };
    }

    const playingFallback = fallbackCandidates.find(isPlayingZone);
    if (playingFallback) return { zone: playingFallback, mode: "fallback" };

    if (activeZone && isPlayingZone(activeZone)) {
      return { zone: activeZone, mode: "playing" };
    }

    const playingAny = zones.find(isPlayingZone);
    if (playingAny) return { zone: playingAny, mode: "playing" };

    const idleHqplayer = hqplayerCandidates[0];
    if (idleHqplayer) return { zone: idleHqplayer, mode: "hqplayer-idle" };

    const idleFallback = fallbackCandidates[0];
    if (idleFallback) return { zone: idleFallback, mode: "fallback-idle" };

    return { zone: null, mode: "" };
  }

  evaluateActiveZone(command) {
    const { zone: selected, mode } = this.selectActiveZone();

    if (!selected) {
      if (this.activeZoneId) this.logger.warn("No matching or playing Roon zone found");
      this.activeZoneId = null;
      this.activeZoneSelectionMode = "";
      this.resetEmissionState();
      this.emit("inactive");
      return;
    }

    if (selected.zone_id !== this.activeZoneId || mode !== this.activeZoneSelectionMode) {
      this.activeZoneId = selected.zone_id;
      this.activeZoneSelectionMode = mode;
      const modeLabel = {
        hqplayer: "HQPlayer zone",
        fallback: "fallback Roon zone",
        playing: "active playing Roon zone",
        "hqplayer-idle": "idle HQPlayer zone",
        "fallback-idle": "idle fallback Roon zone"
      }[mode] || "Roon zone";
      this.logger.info(`Using ${modeLabel}: ${selected.display_name || selected.zone_id}`);
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
      selectionMode: mode,
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

    if (this.isSeekJump(seek, now) && now - this.lastEmittedAt >= NOW_PLAYING_MIN_EMIT_MS) {
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
    const endpoint = getRoonImageEndpoint(this.core);
    if (!imageKey || !endpoint) return;

    const encodedKey = encodeURIComponent(imageKey);
    zone.now_playing.album_art_url =
      `http://${endpoint.host}:${endpoint.port}/api/image/${encodedKey}?width=512&height=512`;

    this.logger.debug("Resolved Roon album art URL", {
      imageKey,
      url: zone.now_playing.album_art_url
    });
    if (isPrivateImageUrl(zone.now_playing.album_art_url)) {
      this.logger.debug("Roon album art URL is local/private; Discord may not render it directly");
    }
  }
}

module.exports = { RoonClient, zoneContentSignature, getRoonImageEndpoint, isPrivateImageUrl, isPlayingZone };
