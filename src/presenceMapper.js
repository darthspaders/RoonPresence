function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function stringifySignalPath(value) {
  if (!value) return "";

  if (typeof value === "string") return cleanText(value);

  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifySignalPath(entry))
      .filter(Boolean)
      .join(" > ");
  }

  if (typeof value === "object") {
    return firstText(
      value.path,
      value.signal_path,
      value.signalPath,
      value.summary,
      value.description,
      value.display_name,
      value.name,
      value.value,
      value.text,
      value.format
    );
  }

  return "";
}

function extractSignalPath(zone, nowPlaying) {
  const candidates = [
    nowPlaying?.signal_path,
    nowPlaying?.signalPath,
    nowPlaying?.hqplayer_signal_path,
    nowPlaying?.hqplayerSignalPath,
    nowPlaying?.output_path,
    nowPlaying?.audio_path,
    nowPlaying?.format,
    nowPlaying?.output_format,
    zone?.signal_path,
    zone?.signalPath,
    zone?.hqplayer_signal_path,
    zone?.hqplayerSignalPath,
    zone?.output_path,
    zone?.audio_path,
    ...(zone?.outputs || []).flatMap((output) => [
      output?.signal_path,
      output?.signalPath,
      output?.hqplayer_signal_path,
      output?.hqplayerSignalPath,
      output?.output_path,
      output?.audio_path,
      output?.format
    ])
  ];

  for (const candidate of candidates) {
    const text = stringifySignalPath(candidate);
    if (text) return text;
  }

  return "";
}

function hasRadioMarker(zone, nowPlaying) {
  const text = [
    zone?.display_name,
    zone?.zone_name,
    nowPlaying?.title,
    nowPlaying?.artist,
    nowPlaying?.album,
    nowPlaying?.one_line?.line1,
    nowPlaying?.two_line?.line1,
    nowPlaying?.two_line?.line2,
    nowPlaying?.three_line?.line1,
    nowPlaying?.three_line?.line2,
    nowPlaying?.three_line?.line3
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return /\bdi\.?fm\b|radio|stream/.test(text);
}

function isLocalTrack(zone, nowPlaying, length, seek) {
  if (zone?.is_seek_allowed === false) return false;
  if (nowPlaying?.is_seek_allowed === false) return false;
  if (hasRadioMarker(zone, nowPlaying)) return false;

  return length !== null && length > 0 && seek !== null && seek >= 0;
}

function getRadioSeekPosition(zone, nowPlaying, seek) {
  if (seek !== null && seek >= 0) return seek;

  const candidates = [
    nowPlaying?.seek_position,
    zone?.seek_position,
    nowPlaying?.queue_time,
    zone?.queue_time,
    nowPlaying?.queue_time_remaining,
    zone?.queue_time_remaining
  ];

  for (const candidate of candidates) {
    const value = asFiniteNumber(candidate);
    if (value !== null && value >= 0) return value;
  }

  return null;
}

class PresenceMapper {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.radioStarts = new Map();
  }

  mapZone(zone) {
    return this.mapPresence(zone)?.activity || null;
  }

  mapPresence(zone) {
    const nowPlaying = zone?.now_playing;
    if (!nowPlaying) return null;

    const length = asFiniteNumber(nowPlaying.length);
    const seek = asFiniteNumber(nowPlaying.seek_position ?? zone.seek_position);
    const title = firstText(
      nowPlaying.three_line?.line1,
      nowPlaying.two_line?.line1,
      nowPlaying.one_line?.line1,
      nowPlaying.title,
      "Roon"
    );
    const artist = firstText(
      nowPlaying.three_line?.line2,
      nowPlaying.two_line?.line2,
      nowPlaying.artist,
      nowPlaying.album,
      zone.display_name
    );
    const albumOrStation = firstText(
      nowPlaying.three_line?.line3,
      nowPlaying.album,
      zone.display_name
    );
    const zoneName = cleanText(zone.display_name || zone.zone_name || zone.zone_id, "Roon");
    const signalPath = extractSignalPath(zone, nowPlaying);
    const albumArtKey = cleanText(nowPlaying.image_key);
    const albumArtUrl = cleanText(
      nowPlaying.album_art_url ||
        nowPlaying.albumArtUrl ||
        nowPlaying.image_url ||
        nowPlaying.imageUrl
    );

    const activity = {
      details: (signalPath ? `${title} - ${artist}` : title).slice(0, 128),
      state: (signalPath || artist).slice(0, 128),
      instance: false
    };

    const timestampMode = isLocalTrack(zone, nowPlaying, length, seek) ? "LOCAL" : "RADIO";
    const timestamps = this.buildTimestamps(zone, nowPlaying, length, seek, timestampMode);
    if (timestamps) activity.timestamps = timestamps;

    if (!activity.state && albumOrStation) {
      activity.state = albumOrStation.slice(0, 128);
    }

    return {
      activity,
      timestampMode,
      metadata: {
        title,
        artist,
        album: albumOrStation,
        zoneName,
        length,
        signalPath,
        albumArtKey,
        albumArtUrl
      }
    };
  }

  buildTimestamps(zone, nowPlaying, length, seek, timestampMode) {
    const nowMs = Math.floor(this.clock());

    if (timestampMode === "LOCAL") {
      const start = nowMs - Math.floor(seek * 1000);
      return { start, end: start + Math.floor(length * 1000) };
    }

    const radioSeek = getRadioSeekPosition(zone, nowPlaying, seek);
    if (radioSeek !== null) {
      return { start: nowMs - Math.floor(radioSeek * 1000) };
    }

    const key = [
      zone?.zone_id || zone?.display_name || "zone",
      nowPlaying?.three_line?.line3 ||
        nowPlaying?.album ||
        nowPlaying?.one_line?.line1 ||
        zone?.display_name ||
        ""
    ].join("|");

    if (!this.radioStarts.has(key)) {
      this.radioStarts.clear();
      this.radioStarts.set(key, nowMs);
    }

    return { start: this.radioStarts.get(key) };
  }
}

module.exports = { PresenceMapper, extractSignalPath };
