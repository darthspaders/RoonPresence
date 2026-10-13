"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");

// Independent listening clock: seeking and browser refreshes do not count as listening.
class LyrionScrobbler {
  constructor(owner) {
    this.owner=owner; this.current=null; this.pending=[]; this.sent={}; this.running=false; this.retryAt=0;
    this.file=owner.scrobbleCachePath ? `${owner.scrobbleCachePath}.lyrion` : "";
    try { const saved=JSON.parse(fs.readFileSync(this.file,"utf8"));this.pending=saved.pending||[];this.sent=saved.sent||{}; } catch {}
  }
  save() {
    if(!this.file)return;
    try {fs.writeFileSync(`${this.file}.tmp`,JSON.stringify({pending:this.pending,sent:this.sent}));fs.renameSync(`${this.file}.tmp`,this.file);}
    catch {this.owner.logger?.warn?.("Could not persist Lyrion scrobble queue");}
  }
  async request(method,track,timestamp) {
    const o=this.owner;
    const params={method,api_key:o.apiKey,sk:o.sessionKey,artist:track.artist,track:track.title};
    if(track.album)params.album=track.album;
    if(track.duration>0)params.duration=String(Math.round(track.duration));
    if(timestamp){params.timestamp=String(timestamp);if(track.radio)params.chosenByUser="0";}
    params.api_sig=crypto.createHash("md5").update(Object.keys(params).sort().map(k=>k+params[k]).join("")+o.apiSecret).digest("hex");
    const response=await o.fetchImpl("https://ws.audioscrobbler.com/2.0/",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...params,format:"json"}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();
    if(!response.ok || result.error){const e=new Error(`Last.fm ${result.error || response.status}: ${result.message || "request failed"}`);e.permanent=!!result.error && ![9,11,16,29].includes(Number(result.error));throw e;}
    return result;
  }
  observe(presence) {
    const now=this.owner.clock(),m=presence?.metadata;
    if(!this.owner.configured || m?.frontend!=="lyrion"){if(this.current)this.current.lastAt=null;return false;}
    const artist=String(m.artist||"").trim(),title=String(m.title||"").trim();
    if(!artist || !title || /^(unknown artist|unknown|untitled)$/i.test(artist) || /^(unknown|untitled)$/i.test(title)){if(this.current)this.current.lastAt=null;return false;}
    const duration=Number(m.length)||0;
    const key=[m.zoneName,artist,title,m.album].join("|");
    if(this.current?.key!==key){
      const track={artist,title,album:m.album||"",duration,radio:duration<=0};
      this.current={key,track,started:Math.floor(now/1000),lastAt:now,listened:0,queued:false};
      this.request("track.updateNowPlaying",track).then(result=>{
        const ignored=result.nowplaying?.ignoredMessage;
        this.owner.logger?.info?.(`Last.fm Lyrion now playing: ${artist} - ${title}`,{ignored:ignored?.code || "0"});
      }).catch(e=>this.owner.logger?.warn?.("Last.fm Lyrion now playing failed",{error:e.message}));
    }else{
      const c=this.current,elapsed=c.lastAt===null?0:now-c.lastAt;
      if(elapsed>0 && elapsed<=15000)c.listened+=elapsed;
      c.lastAt=now;
    }
    const c=this.current,threshold=duration>0?Math.min(duration*500,240000):240000;
    if(!c.queued && (duration===0 || duration>30) && c.listened>=threshold){
      c.queued=true;
      // Suppress a duplicate if the service restarted during the same playback.
      if(!this.sent[key] || now-this.sent[key]>Math.max(duration*1000,15*60000)){
        this.pending.push({key,track:c.track,timestamp:c.started});this.sent[key]=now;
        for(const k of Object.keys(this.sent))if(now-this.sent[k]>86400000)delete this.sent[k];
        this.save();
      }
    }
    this.drain();return true;
  }
  async drain() {
    if(this.running || !this.owner.configured || this.owner.clock()<this.retryAt)return;
    this.running=true;
    try {
      while(this.pending.length){
        const entry=this.pending[0];
        try {
          const result=await this.request("track.scrobble",entry.track,entry.timestamp);
          const accepted=Number(result.scrobbles?.["@attr"]?.accepted||0);
          this.owner.logger?.info?.(`Last.fm Lyrion scrobble ${accepted?"accepted":"ignored"}: ${entry.track.artist} - ${entry.track.title}`);
          this.pending.shift();this.save();
        }catch(e){
          this.owner.logger?.warn?.("Last.fm Lyrion scrobble failed",{error:e.message});
          if(e.permanent){this.pending.shift();this.save();continue;}
          this.retryAt=this.owner.clock()+60000;break;
        }
      }
    }finally{this.running=false;}
  }
  pause(){if(this.current)this.current.lastAt=null;this.drain();}
}
module.exports={LyrionScrobbler};
