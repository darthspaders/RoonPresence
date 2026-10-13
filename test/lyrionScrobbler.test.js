const {test}=require("node:test");
const assert=require("node:assert/strict");
const {LyrionScrobbler}=require("../src/lyrionScrobbler");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
function setup(){
  let now=1000000;const calls=[];
  const owner={configured:true,clock:()=>now,apiKey:"key",apiSecret:"secret",sessionKey:"session",fetchImpl:async(url,options)=>{calls.push(Object.fromEntries(options.body));return{ok:true,json:async()=>({scrobbles:{"@attr":{accepted:1}}})};}};
  const s=new LyrionScrobbler(owner);
  const p={metadata:{frontend:"lyrion",artist:"Artist",title:"Track",album:"Album",length:100,zoneName:"Player"}};
  return{s,p,calls,tick:(ms=10000)=>{now+=ms;s.observe(p);}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test("Lyrion sends now playing then one scrobble after actual half-track listening",async()=>{
  const {s,p,calls,tick}=setup();s.observe(p);await settle();
  assert.equal(calls[0].method,"track.updateNowPlaying");
  for(let i=0;i<4;i++)tick();assert.equal(calls.length,1);
  tick();await settle();assert.equal(calls[1].method,"track.scrobble");assert.equal(calls[1].timestamp,"1000");
  tick();await settle();assert.equal(calls.length,2);
});
test("pauses and polling gaps do not count and short tracks do not scrobble",async()=>{
  const {s,p,calls,tick}=setup();s.observe(p);tick();s.pause();tick(600000);tick();
  assert.equal(s.current.listened,20000);tick(600000);assert.equal(s.current.listened,20000);
  p.metadata.title="Short";p.metadata.length=20;s.observe(p);for(let i=0;i<10;i++)tick();await settle();
  assert.equal(calls.filter(c=>c.method==="track.scrobble").length,0);
});
test("live streams require four minutes; failed scrobbles remain queued",async()=>{
  const {s,p,calls,tick}=setup();p.metadata.length=0;s.observe(p);
  s.owner.fetchImpl=async()=>{throw new Error("offline");};
  for(let i=0;i<24;i++)tick();await settle();assert.equal(s.pending.length,1);
  s.owner.fetchImpl=async(url,options)=>{calls.push(Object.fromEntries(options.body));return{ok:true,json:async()=>({scrobbles:{"@attr":{accepted:1}}})};};
  tick(60000);await settle();assert.equal(s.pending.length,0);assert.equal(calls.at(-1).chosenByUser,"0");
});
test("pending submissions survive restart and retain their original listening timestamp",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lyrion-scrobble-"));
  try{
    const {s,p,tick}=setup();s.file=path.join(dir,"queue.json");
    s.owner.fetchImpl=async()=>{throw new Error("offline");};s.observe(p);
    for(let i=0;i<5;i++)tick();await settle();
    const owner={...s.owner,scrobbleCachePath:path.join(dir,"cache")};
    fs.renameSync(s.file,`${owner.scrobbleCachePath}.lyrion`);
    const restored=new LyrionScrobbler(owner);assert.equal(restored.pending.length,1);
    assert.equal(restored.pending[0].timestamp,1000);
    let submitted;
    owner.fetchImpl=async(url,opts)=>{submitted=Object.fromEntries(opts.body);return{ok:true,json:async()=>({scrobbles:{"@attr":{accepted:1}}})};};
    await restored.drain();assert.equal(restored.pending.length,0);assert.equal(submitted.timestamp,"1000");
    assert.equal(JSON.parse(fs.readFileSync(restored.file)).pending.length,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
