// The frontend: three dialogs, in the style of the file managers that shipped
// with desktops before the web took the job over. Grey face, bevelled edges,
// a title bar with a close box.
//
//   /         two buttons and a storage meter
//   /upload   what to send, which pin, go
//   /get      type a pin, take the thing behind it
//
// Everything works with JavaScript off except folder upload, which needs it —
// the folder is zipped in the browser so the Worker never has to.
import { csize, esc, hsize, icon, viewable, when } from "./util.js";

const CSS = `
:root{--face:#c0c0c0;--hi:#fff;--sh:#808080;--dk:#000;--ink:#000;
  --nav:#000080;--nav2:#1084d0;--desk:#008080;--well:#fff;
  --ui:"MS Sans Serif",Tahoma,Geneva,Verdana,sans-serif;
  --mono:ui-monospace,"DejaVu Sans Mono",Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--desk);color:var(--ink);
  font:13px/1.45 var(--ui);display:flex;align-items:center;justify-content:center;padding:20px}
/* the bevel every raised surface shares */
.up{box-shadow:inset -1px -1px 0 var(--dk),inset 1px 1px 0 var(--hi),
  inset -2px -2px 0 var(--sh),inset 2px 2px 0 var(--face)}
.down{box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--dk),inset -2px -2px 0 var(--face)}
.win{width:400px;max-width:100%;background:var(--face);padding:3px;
  box-shadow:inset -1px -1px 0 var(--dk),inset 1px 1px 0 var(--hi),
  inset -2px -2px 0 var(--sh),inset 2px 2px 0 var(--face)}
.tbar{display:flex;align-items:center;gap:6px;padding:2px 2px 2px 4px;
  background:linear-gradient(90deg,var(--nav),var(--nav2));color:#fff;font-weight:700}
.tbar b{flex:1;font-size:12px;letter-spacing:.2px}
.x{width:18px;height:16px;background:var(--face);color:#000;text-decoration:none;
  display:flex;align-items:center;justify-content:center;font:700 11px/1 var(--ui);
  box-shadow:inset -1px -1px 0 var(--dk),inset 1px 1px 0 var(--hi),
  inset -2px -2px 0 var(--sh),inset 2px 2px 0 var(--face)}
.x:active{box-shadow:inset 1px 1px 0 var(--dk),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--sh),inset -2px -2px 0 var(--face)}
.body{padding:14px 13px 12px}
h2{font-size:13px;margin:0 0 8px;font-weight:700}
p{margin:0 0 10px}
legend,.lab{font-weight:700;display:block;margin:0 0 5px}
fieldset{border:0;padding:0;margin:0 0 12px}
hr{border:0;border-top:1px solid var(--sh);border-bottom:1px solid var(--hi);margin:12px 0}

/* the two big choices */
.tiles{display:flex;gap:12px;margin:2px 0 14px}
.tile{flex:1;background:var(--face);color:var(--ink);text-decoration:none;padding:16px 8px 12px;
  display:flex;flex-direction:column;align-items:center;gap:9px;font-weight:700;
  box-shadow:inset -1px -1px 0 var(--dk),inset 1px 1px 0 var(--hi),
  inset -2px -2px 0 var(--sh),inset 2px 2px 0 var(--face)}
.tile:active{box-shadow:inset 1px 1px 0 var(--dk),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--sh),inset -2px -2px 0 var(--face)}
.tile svg{display:block}
.tile span{font-weight:400;font-size:11px;color:#404040}

/* controls */
button,.btn{font:13px var(--ui);background:var(--face);color:var(--ink);border:0;
  padding:5px 14px;min-width:82px;cursor:pointer;text-align:center;text-decoration:none;
  box-shadow:inset -1px -1px 0 var(--dk),inset 1px 1px 0 var(--hi),
  inset -2px -2px 0 var(--sh),inset 2px 2px 0 var(--face)}
button:active,.btn:active{box-shadow:inset 1px 1px 0 var(--dk),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--sh),inset -2px -2px 0 var(--face)}
button[disabled]{color:var(--sh);text-shadow:1px 1px 0 var(--hi);cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap}
input[type=text],input[type=password]{font:13px var(--mono);background:var(--well);color:var(--ink);
  border:0;padding:4px 5px;width:100%;
  box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--dk),inset -2px -2px 0 var(--face)}
input[type=text][disabled]{background:var(--face);color:var(--sh)}
input[type=file]{font:12px var(--ui);width:100%;padding:6px;background:var(--well);
  box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--dk),inset -2px -2px 0 var(--face)}
label.opt{display:flex;align-items:center;gap:7px;padding:2px 0;font-weight:400;cursor:pointer}
label.opt small{color:#404040}
.pinbox{display:flex;align-items:center;gap:7px;margin-top:2px}
.pinbox input{flex:1}

/* wells */
.well{background:var(--well);padding:9px 10px;font:12px var(--mono);word-break:break-all;
  box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--dk),inset -2px -2px 0 var(--face)}
.well .nm{font-weight:700}
.well .sub{color:#404040;margin-top:3px}
.kv{margin:10px 0 12px;font:12px var(--mono)}
.kv div{display:flex;gap:8px;padding:1px 0}
.kv span{width:34px;color:#404040;flex:none}

/* status bar + meter */
.stat{margin-top:12px;display:flex;align-items:center;gap:8px;padding:3px 4px;
  font-size:11px;box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi)}
.stat .t{white-space:nowrap}
.meter{flex:1;height:15px;background:var(--well);padding:2px;
  box-shadow:inset 1px 1px 0 var(--sh),inset -1px -1px 0 var(--hi),
  inset 2px 2px 0 var(--dk),inset -2px -2px 0 var(--face)}
.meter i{display:block;height:100%;
  background:repeating-linear-gradient(90deg,var(--nav) 0 7px,var(--well) 7px 9px)}
.err{color:#800000;font-weight:700}
.foot{margin-top:12px;font-size:11px;color:#404040}
.foot .well{margin-top:4px;font-size:11px;padding:6px 8px}
`;

const UPICON =
  '<svg width="40" height="40" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
  '<path d="M8 1l4 5H9.5v4h-3V6H4z" fill="#000080"/>' +
  '<path d="M1 11h3v1h8v-1h3v4H1z" fill="#404040"/></svg>';
const DOWNICON =
  '<svg width="40" height="40" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
  '<path d="M6.5 1h3v4H12L8 10 4 5h2.5z" fill="#000080"/>' +
  '<path d="M1 11h3v1h8v-1h3v4H1z" fill="#404040"/></svg>';

// Zips the picked folder in the browser (STORE, no compression) so the Worker
// never spends CPU on it, then posts the one blob with a progress readout.
const JS = `
var CT=null;
function crcT(){if(CT)return CT;CT=new Uint32Array(256);
  for(var n=0;n<256;n++){var c=n;for(var k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CT[n]=c>>>0}
  return CT}
function crc32(b){var t=crcT(),c=0xFFFFFFFF;
  for(var i=0;i<b.length;i++)c=t[(c^b[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function stamp(ms){var d=new Date(ms||Date.now());
  return{t:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((d.getSeconds()/2|0)&31),
    d:(((d.getFullYear()-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31)}}
function zipOf(files,on){
  var enc=new TextEncoder(),parts=[],cen=[],off=0,done=0,total=0,i;
  for(i=0;i<files.length;i++)total+=files[i].size;
  return files.reduce(function(chain,f){return chain.then(function(){
    return f.arrayBuffer().then(function(ab){
      var buf=new Uint8Array(ab),nb=enc.encode(f.webkitRelativePath||f.name),
        crc=crc32(buf),st=stamp(f.lastModified),
        lh=new Uint8Array(30+nb.length),v=new DataView(lh.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);
      v.setUint16(8,0,true);v.setUint16(10,st.t,true);v.setUint16(12,st.d,true);
      v.setUint32(14,crc,true);v.setUint32(18,buf.length,true);v.setUint32(22,buf.length,true);
      v.setUint16(26,nb.length,true);v.setUint16(28,0,true);lh.set(nb,30);
      parts.push(lh,f);
      cen.push({nb:nb,crc:crc,size:buf.length,off:off,st:st});
      off+=lh.length+buf.length;done+=buf.length;on(done,total)})})},Promise.resolve())
  .then(function(){
    var cd=0,j;
    for(j=0;j<cen.length;j++){var e=cen[j],b=new Uint8Array(46+e.nb.length),v=new DataView(b.buffer);
      v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);
      v.setUint16(8,0x800,true);v.setUint16(10,0,true);v.setUint16(12,e.st.t,true);
      v.setUint16(14,e.st.d,true);v.setUint32(16,e.crc,true);v.setUint32(20,e.size,true);
      v.setUint32(24,e.size,true);v.setUint16(28,e.nb.length,true);v.setUint32(42,e.off,true);
      b.set(e.nb,46);parts.push(b);cd+=b.length}
    var eo=new Uint8Array(22),v2=new DataView(eo.buffer);
    v2.setUint32(0,0x06054b50,true);v2.setUint16(8,cen.length,true);v2.setUint16(10,cen.length,true);
    v2.setUint32(12,cd,true);v2.setUint32(16,off,true);parts.push(eo);
    return new Blob(parts,{type:'application/zip'})})}

function q(s){return document.querySelector(s)}
function say(t,bad){var o=q('#out');if(o){o.textContent=t;o.className=bad?'t err':'t'}}
function mode(){
  var dir=q('#mdir').checked;
  q('#f').disabled=dir;q('#f').hidden=dir;
  q('#dir').disabled=!dir;q('#dir').hidden=!dir;
  q('#pin').disabled=!q('#mcustom').checked;
}
function ready(){
  var r=q('#mdir');if(!r)return;
  r.disabled=false;
  var n=q('#nojs');if(n)n.remove();
  var i;for(i=0;i<document.forms[0].elements.length;i++)
    document.forms[0].elements[i].addEventListener('change',mode);
  mode();
}
function send(ev){
  ev.preventDefault();
  var dir=q('#mdir').checked,src=dir?q('#dir'):q('#f'),files=[].slice.call(src.files);
  if(!files.length){say(dir?'pick a folder first':'pick a file first',1);return false}
  q('#go').disabled=true;
  var name=dir?((files[0].webkitRelativePath||'folder').split('/')[0]||'folder')+'.zip':files[0].name;
  var pin=q('#mcustom').checked?q('#pin').value.trim():'';
  var pack=dir?zipOf(files,function(d,t){say('packing '+name+'... '+Math.round(d/t*100)+'%')})
    :Promise.resolve(files[0]);
  pack.then(function(blob){
    var fd=new FormData();
    fd.append('f',blob,name);
    if(pin)fd.append('pin',pin);
    var x=new XMLHttpRequest();
    x.open('POST','/up?json=1');
    x.setRequestHeader('Accept','application/json');
    x.upload.onprogress=function(e){if(e.lengthComputable)
      say('sending '+name+'... '+Math.round(e.loaded/e.total*100)+'%')};
    x.onload=function(){
      if(x.status>=200&&x.status<300){
        location.href='/get?new=1&pin='+encodeURIComponent(JSON.parse(x.responseText).pin)}
      else{q('#go').disabled=false;say('failed ('+x.status+'): '+x.responseText,1)}};
    x.onerror=function(){q('#go').disabled=false;say('network error',1)};
    say('sending '+name+'...');
    x.send(fd)},
    function(e){q('#go').disabled=false;say('could not pack it: '+e,1)});
  return false;
}
if(q('#mdir'))ready();
`;

function shell(title, body, withJs = false) {
  return "<!doctype html><html lang=en><head><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<meta name=robots content='noindex,nofollow'>" +
    "<title>" + esc(title) + "</title><style>" + CSS + "</style></head><body>" +
    body + (withJs ? "<script>" + JS + "</script>" : "") + "</body></html>";
}

// One dialog window: title bar, close box, contents.
function win(title, close, body, closeLabel = "close") {
  return '<div class="win"><div class="tbar"><b>' + esc(title) + "</b>" +
    '<a class="x" href="' + close + '" title="' + esc(closeLabel) + '">&times;</a></div>' +
    '<div class="body">' + body + "</div></div>";
}

export function loginPage(next, bad) {
  return shell("dropbin", win("dropbin", "/", `
    <form method="post" action="/api/login">
      <p class="lab">Password</p>
      <input type="password" name="pass" autofocus autocomplete="current-password">
      <input type="hidden" name="next" value="${esc(next || "/")}">
      ${bad ? '<p class="err" style="margin-top:10px">Wrong password.</p>' : ""}
      <hr>
      <div class="row"><button type="submit">OK</button></div>
    </form>`));
}

/** The front door: two options, and how much room is left. */
export function homePage(origin, host, used, cap, pins) {
  const free = Math.max(0, cap - used);
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return shell("dropbin", win("dropbin", "/api/logout", `
    <div class="tiles">
      <a class="tile" href="/upload">${UPICON}Upload<span>file or folder</span></a>
      <a class="tile" href="/get">${DOWNICON}Download<span>with a pin</span></a>
    </div>
    <div class="stat">
      <span class="t">${esc(hsize(free))} free</span>
      <span class="meter"><i style="width:${pct}%"></i></span>
      <span class="t">of ${esc(hsize(cap))}</span>
    </div>
    <p class="foot">${esc(host)} &middot; ${pins} pin${pins === 1 ? "" : "s"} stored
      <span class="well">curl -s ${esc(origin)}/cli -o drop &amp;&amp; bash drop</span></p>`,
    "sign out"));
}

/** Pick a file or a folder, pick a pin, send it. */
export function uploadPage() {
  return shell("Upload — dropbin", win("Upload", "/", `
    <form method="post" action="/up" enctype="multipart/form-data" onsubmit="return send(event)">
      <fieldset>
        <span class="lab">What are you sending?</span>
        <label class="opt"><input type="radio" name="m" id="mfile" value="file" checked> File</label>
        <label class="opt"><input type="radio" name="m" id="mdir" value="dir" disabled> Folder
          <small id="nojs">(needs JavaScript)</small></label>
        <div style="margin-top:7px">
          <input type="file" id="f" name="f">
          <input type="file" id="dir" webkitdirectory directory multiple disabled hidden>
        </div>
      </fieldset>
      <fieldset>
        <span class="lab">Pin</span>
        <label class="opt"><input type="radio" name="k" id="mrandom" value="random" checked>
          Random <small>&mdash; 4 digits</small></label>
        <label class="opt"><input type="radio" name="k" id="mcustom" value="custom">
          Custom <small>&mdash; anything you like</small></label>
        <div class="pinbox"><input type="text" id="pin" name="pin" maxlength="64"
          placeholder="my-pin" disabled></div>
      </fieldset>
      <hr>
      <div class="row"><button type="submit" id="go">Upload</button>
        <a class="btn" href="/">Cancel</a></div>
      <div class="stat"><span class="t" id="out">A folder is zipped here before it is sent.</span></div>
    </form>`), true);
}

/**
 * Type a pin, get the one thing behind it. Also the page an upload lands on,
 * which is why it can say "Uploaded" instead.
 */
export function getPage(origin, pin, hit, fresh) {
  const form = (label) => `
    <form method="get" action="/get">
      <span class="lab">${label}</span>
      <div class="pinbox">
        <input type="text" name="pin" maxlength="64" autofocus
          placeholder="4821" value="${esc(pin || "")}">
        <button type="submit">Open</button>
      </div>
    </form>`;

  if (!hit) {
    return shell("Download — dropbin", win("Download", "/",
      (pin ? `<p class="err">No such pin: ${esc(pin)}</p>` : "") +
      form("Pin") +
      '<hr><div class="row"><a class="btn" href="/">Cancel</a></div>'));
  }

  const href = "/" + encodeURIComponent(pin);
  const title = fresh ? "Uploaded" : "Download";
  return shell(title + " — dropbin", win(title, "/", `
    ${fresh ? '<p>Saved. This pin is the only way back to it.</p>' : ""}
    <div class="well">
      <div class="nm">${esc(icon(hit.name))} ${esc(hit.name)}</div>
      <div class="sub">${esc(csize(hit.size))}${hit.at ? " &middot; " + esc(when(hit.at)) : ""}</div>
    </div>
    <div class="kv">
      <div><span>pin</span><b>${esc(pin)}</b></div>
      <div><span>url</span>${esc(origin + href)}</div>
    </div>
    <hr>
    <div class="row">
      <a class="btn" href="${href}">Download</a>
      ${viewable(hit.name) ? `<a class="btn" href="${href}?view=1">View</a>` : ""}
      <a class="btn" href="/">Close</a>
    </div>`));
}
