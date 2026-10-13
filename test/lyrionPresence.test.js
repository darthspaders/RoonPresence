const test=require("node:test");
const assert=require("node:assert/strict");
const {LyrionPresence,mapLyrionPresence}=require("../src/lyrionPresence");
const sample={state:"playing",playerName:"HQPlayer",position:20,duration:100,nowPlaying:{title:"Track",artist:"Artist",album:"Album",source:"TIDAL",artwork:"/api/lyrion/artwork?path=x"}};
test("Lyrion preserves metadata and timing without Roon radio interpretation",()=>{
 const p=mapLyrionPresence({lyrion:sample},()=>50000);assert.equal(p.activity.timestamps.start,30000);assert.equal(p.activity.timestamps.end,130000);assert.equal(p.metadata.source,"TIDAL");assert.match(p.metadata.zoneName,/Lyrion.*HQPlayer/);
 const live=mapLyrionPresence({lyrion:{...sample,duration:0}},()=>50000);assert.equal(live.activity.timestamps.end,undefined);
});
test("Presence follows playing Lyrion, suppresses Roon events, then restores Roon on failure",async()=>{
 const published=[];let fail=false;const p=new LyrionPresence({baseUrl:"http://localhost:3777",publisher:{publishZone:z=>published.push(z),clear:()=>published.push(null)},signalPathProvider:{setPlaybackActive(){},start(){},stop(){}},fetchImpl:async()=>{if(fail)throw Error("offline");return{ok:true,json:async()=>({frontend:"lyrion",lyrion:structuredClone(sample)})};}});
 p.stopped=false;await p.poll();assert.equal(p.active,true);assert.match(published[0].lyrion.nowPlaying.artwork,/^http/);
 p.roonPlaying({zone_id:"roon"});assert.equal(published.length,1);fail=true;await p.poll();assert.equal(published[1].zone_id,"roon");
});
test("Neither frontend playing clears stale Lyrion presence",async()=>{
 let cleared=0;const p=new LyrionPresence({baseUrl:"http://localhost",publisher:{clear:()=>cleared++},signalPathProvider:{setPlaybackActive(){},stop(){}},fetchImpl:async()=>({ok:true,json:async()=>({frontend:null})})});p.stopped=false;p.active=true;await p.poll();assert.equal(cleared,1);
});
