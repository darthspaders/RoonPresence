"use strict";

function mapLyrionPresence(zone, clock = Date.now) {
  const s = zone.lyrion, t = s?.nowPlaying;
  if (!t || s.state !== "playing") return null;
  const start = clock() - Math.max(0, s.position || 0) * 1000;
  return { activity: { details: [t.artist, t.title].filter(Boolean).join(" - ").slice(0, 128),
    state: [t.album, t.source].filter(Boolean).join(" · ").slice(0, 128),
    timestamps: { start, ...(s.duration > 0 ? { end: start + s.duration * 1000 } : {}) } },
    timestampMode: s.duration > 0 ? "LOCAL" : "RADIO",
    metadata: { title: t.title, artist: t.artist, album: t.album, originalTitle: t.title, originalArtist: t.artist,
      originalAlbum: t.album, radioStationName: "", zoneName: `Lyrion · ${s.playerName} · ${t.source}`,
      length: s.duration || null, signalPath: "", albumArtKey: "", albumArtUrl: t.artwork || "", frontend: "lyrion", source: t.source } };
}

class LyrionPresence {
  constructor({ baseUrl, publisher, signalPathProvider, fetchImpl = fetch, pollMs = 3000 }) {
    this.url = new URL("/api/lyrion/presence", baseUrl).href;
    this.publisher = publisher; this.signalPathProvider = signalPathProvider; this.fetch = fetchImpl; this.pollMs = pollMs;
    this.active = false; this.roonZone = null; this.timer = null; this.stopped = true;
  }
  roonPlaying(zone) { this.roonZone = zone; if (!this.active) this.publisher.publishZone(zone); }
  roonInactive() { this.roonZone = null; return this.active; }
  async poll() {
    let status;
    try {
      const response = await this.fetch(this.url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Playback status unavailable");
      status = await response.json();
    } catch { status = { frontend: this.roonZone ? "roon" : null }; }
    if (this.stopped) return;
    const wasActive = this.active;
    this.active = status.frontend === "lyrion" && status.lyrion?.state === "playing";
    if (this.active) {
      if (status.lyrion.nowPlaying?.artwork) status.lyrion.nowPlaying.artwork = new URL(status.lyrion.nowPlaying.artwork, this.url).href;
      this.signalPathProvider.setPlaybackActive(true); this.signalPathProvider.start();
      this.publisher.publishZone({ frontend: "lyrion", lyrion: status.lyrion });
    } else if (wasActive) {
      if (this.roonZone) this.publisher.publishZone(this.roonZone);
      else { this.signalPathProvider.setPlaybackActive(false); this.signalPathProvider.stop(); this.publisher.clear(); }
    }
  }
  start() {
    this.stopped = false;
    const tick = async () => { try { await this.poll(); } finally { if (!this.stopped) this.timer = setTimeout(tick, this.pollMs); } };
    tick();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
module.exports = { LyrionPresence, mapLyrionPresence };
