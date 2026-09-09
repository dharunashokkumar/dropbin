// dropbin — one password, one pin, one thing behind it.
//
// A pin holds exactly one object: the file you uploaded, or the zip your folder
// was packed into before it left your machine. The key is `PIN/name`, so
// finding what a pin holds is one `list({ prefix: pin + "/" })`.

export const APP = "dropbin";
export const te = new TextEncoder();

// How much a single legacy ?zip=1 may hash. A CPU budget, not a size limit:
// ~1.4 ms per MB against the free plan's 10 ms per request.
export function zipLimit(env) {
  const mb = Number(env.ZIP_LIMIT_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 5) * 1024 * 1024;
}

// The storage the meter counts down from. R2's free tier is 10 GB.
export function quota(env) {
  const gb = Number(env.QUOTA_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : 10) * 1024 * 1024 * 1024;
}

/* ---------------------------------------------------------------- auth --- */

export function eq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = te.encode(a), y = te.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function token(pass) {
  const d = await crypto.subtle.digest("SHA-256", te.encode(APP + ":" + pass));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cookie(req, name) {
  const m = new RegExp("(?:^|;\\s*)" + name + "=([^;]*)").exec(req.headers.get("cookie") || "");
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

export function rawPass(req, url) {
  const h = req.headers.get("x-pass");
  if (h) return h;
  const q = url.searchParams.get("p") ?? url.searchParams.get("pass");
  if (q) return q;
  const a = req.headers.get("authorization") || "";
  if (a.startsWith("Basic ")) {
    try { const d = atob(a.slice(6)); return d.slice(d.indexOf(":") + 1); } catch { /* ignore */ }
  }
  return null;
}

export async function authed(req, url, env) {
  const want = env.ACCESS_PASSWORD || "changeme";
  const raw = rawPass(req, url);
  if (raw !== null && eq(raw, want)) return true;
  const c = cookie(req, "dp");
  if (c && eq(c, await token(want))) return true;
  return false;
}

/* --------------------------------------------------------- share links --- */
// `db open` and `db qr` hand a link to a browser or a phone, and neither can be
// asked for the password. So the link carries a `?k=` of its own: an expiry and
// an HMAC of the pin, keyed on the password. It is stateless (nothing is stored
// anywhere), it opens exactly one pin, and it is read-only — the router hands a
// `k` visitor to the preview page and to GET, and to nothing else.
//
// `cli/src/api.js` builds the same string; the two must agree byte for byte.

// The longest a share link may be signed for. Whoever signs one holds the
// password and could mint another, so this is a footgun guard, not a lock:
// it stops a link from being valid for the next century. `db` asks for a week.
export function shareTtl(env) {
  const h = Number(env.SHARE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 720) * 3600;   // 30 days
}

export async function sign(pass, pin, exp) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(pass), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // "/" is the one character pinOk() forbids, so the three parts cannot blur.
  const mac = await crypto.subtle.sign("HMAC", key, te.encode(APP + "/" + pin + "/" + exp));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

/** True if `?k=` is a live signature for this pin. */
export async function shared(url, env, pin) {
  const k = url.searchParams.get("k") || "";
  const dot = k.indexOf(".");
  if (dot < 1) return false;
  const exp = k.slice(0, dot);
  if (!/^\d{1,12}$/.test(exp)) return false;
  const now = Date.now();
  if (Number(exp) * 1000 < now || Number(exp) * 1000 > now + shareTtl(env) * 1000) return false;
  return eq(k.slice(dot + 1), await sign(env.ACCESS_PASSWORD || "changeme", pin, exp));
}

/* ------------------------------------------------------------ responses --- */

export const BASE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };

export function text(s, status = 200, extra = {}) {
  return new Response(s.endsWith("\n") ? s : s + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...BASE, ...extra },
  });
}
export function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...BASE },
  });
}
export function html(s, status = 200, extra = {}) {
  return new Response(s, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...BASE, ...extra },
  });
}

// How should this client be answered?  json | html | text
export function fmt(req, url) {
  if (url.searchParams.get("json") === "1") return "json";
  const a = req.headers.get("accept") || "";
  if (a.includes("application/json")) return "json";
  if (a.includes("text/html")) return "html";
  return "text";
}

/* --------------------------------------------------------------- utils --- */

// Decimals are chosen from the value *after* rounding, so 9.9999 GB and 10 GB
// don't come out as "10.00 GB free of 10.0 GB".
export function hsize(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  if (i === 0) return n + " B";
  return n.toFixed(n >= 99.95 ? 0 : n >= 9.995 ? 1 : 2) + " " + u[i];
}

// Apache-ish compact size: 812, 4.1K, 1.2M
export function csize(n) {
  if (n < 1024) return String(n);
  const u = ["K", "M", "G", "T"];
  let i = -1;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + u[i];
}

export function when(d) {
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A stored name is one path segment — no folders, nothing that could escape the pin.
export function cleanName(n) {
  const s = String(n || "").replace(/\\/g, "/").split("/").pop() || "";
  return s.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) || "file";
}

// A custom pin is whatever you like, as long as it stays one URL segment.
export function pinOk(p) {
  if (typeof p !== "string") return false;
  const s = p.trim();
  return !!s && s.length <= 64 && s !== "." && s !== ".." && !/[/\\\x00-\x1f\x7f]/.test(s);
}

// Four digits, 1000-9999. Nine thousand of them, so check before handing one out.
export async function newPin(env) {
  for (let i = 0; i < 24; i++) {
    const p = String((crypto.getRandomValues(new Uint32Array(1))[0] % 9000) + 1000);
    const l = await env.BUCKET.list({ prefix: p + "/", limit: 1 });
    if (!l.objects.length) return p;
  }
  // Every 4-digit pin is taken. Widen rather than overwrite someone's upload.
  for (;;) {
    const p = String((crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000);
    const l = await env.BUCKET.list({ prefix: p + "/", limit: 1 });
    if (!l.objects.length) return p;
  }
}

export async function listAll(env, prefix = "", max = 4000) {
  const out = [];
  let cursor;
  do {
    const r = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    out.push(...r.objects);
    cursor = r.truncated ? r.cursor : null;
  } while (cursor && out.length < max);
  return out;
}

// What a pin holds. One object for anything this version wrote; older pins can
// still hold several, and the router zips those on the way out.
export async function pinItems(env, pin) {
  return listAll(env, pin + "/");
}

// The whole bucket, for the meter. One object per pin keeps this cheap.
export async function usage(env) {
  let used = 0;
  const pins = new Set();
  let cursor;
  do {
    const r = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const o of r.objects) { used += o.size; pins.add(o.key.split("/")[0]); }
    cursor = r.truncated ? r.cursor : null;
  } while (cursor);
  return { used, pins: pins.size };
}

export const TYPES = {
  txt: "text/plain", md: "text/plain", log: "text/plain", csv: "text/csv",
  json: "application/json", js: "text/plain", mjs: "text/plain", cjs: "text/plain",
  ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/plain",
  rb: "text/plain", go: "text/plain", rs: "text/plain", java: "text/plain",
  kt: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain",
  hpp: "text/plain", cs: "text/plain", php: "text/plain", swift: "text/plain",
  sh: "text/plain", bash: "text/plain", zsh: "text/plain", bat: "text/plain",
  ps1: "text/plain", yml: "text/plain", yaml: "text/plain", toml: "text/plain",
  ini: "text/plain", cfg: "text/plain", conf: "text/plain", env: "text/plain",
  sql: "text/plain", diff: "text/plain", patch: "text/plain", lock: "text/plain",
  css: "text/css", html: "text/html", htm: "text/html", xml: "application/xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
  ico: "image/x-icon", heic: "image/heic", pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip",
  tar: "application/x-tar", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
};

export function ext(name) { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); }
export function guessType(name) { return TYPES[ext(name)] || "application/octet-stream"; }
export function isImage(name) { return (TYPES[ext(name)] || "").startsWith("image/"); }
export function isText(name) {
  const t = TYPES[ext(name)] || "";
  return t.startsWith("text/") || t === "application/json" || t === "application/xml";
}
export function isAudio(name) { return (TYPES[ext(name)] || "").startsWith("audio/"); }
export function isMedia(name) {
  const t = TYPES[ext(name)] || "";
  return t.startsWith("video/") || t.startsWith("audio/");
}
export function viewable(name) { return isImage(name) || isText(name) || isMedia(name) || ext(name) === "pdf"; }

// The little text markers a file browser has always used.
export function icon(name) {
  const t = TYPES[ext(name)] || "";
  if (t.startsWith("image/")) return "[IMG]";
  if (t.startsWith("video/")) return "[VID]";
  if (t.startsWith("audio/")) return "[SND]";
  if (t === "application/pdf") return "[PDF]";
  if (/zip|gzip|tar|7z|rar/.test(t)) return "[ZIP]";
  if (t.startsWith("text/") || t === "application/json" || t === "application/xml") return "[TXT]";
  return "[   ]";
}

/* ----------------------------------------------------------------- zip --- */
// Only the legacy path uses this: pins written by older versions hold several
// objects, and they come back out as one zip. New uploads arrive already packed.

// CRC32, slice-by-8. The byte-at-a-time loop costs ~3.4 ms per MB and a Worker
// on the free plan gets 10 ms per request; this one costs ~1.4 ms.
let TABS = null;
function crcTables() {
  if (TABS) return TABS;
  const t0 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  const t = [t0];
  for (let i = 1; i < 8; i++) {
    const p = t[i - 1], cur = new Uint32Array(256);
    for (let n = 0; n < 256; n++) cur[n] = (t0[p[n] & 0xff] ^ (p[n] >>> 8)) >>> 0;
    t.push(cur);
  }
  return (TABS = t);
}

export function crc32(buf) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = crcTables();
  let c = 0xffffffff, i = 0;
  const n = buf.length, lim = n - 8;
  while (i <= lim) {
    c ^= buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    c = t7[c & 0xff] ^ t6[(c >>> 8) & 0xff] ^ t5[(c >>> 16) & 0xff] ^ t4[(c >>> 24) & 0xff] ^
        t3[buf[i + 4]] ^ t2[buf[i + 5]] ^ t1[buf[i + 6]] ^ t0[buf[i + 7]];
    i += 8;
  }
  for (; i < n; i++) c = t0[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d) {
  const t = ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | (((d.getUTCSeconds() / 2) | 0) & 31);
  const dt = (((d.getUTCFullYear() - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31);
  return { t, d: dt };
}

// Streams a STORE-method zip; `strip` characters come off the front of every key
// to make the entry name. One file is held in memory at a time; the reader's
// backpressure drives `pull`.
export function zipStream(env, objects, strip) {
  let i = 0, offset = 0;
  const central = [];
  return new ReadableStream({
    async pull(c) {
      if (i < objects.length) {
        const o = objects[i++];
        const nameBytes = te.encode(o.key.slice(strip));
        const got = await env.BUCKET.get(o.key);
        const data = new Uint8Array(got ? await got.arrayBuffer() : 0);
        const crc = crc32(data);
        const st = dosStamp(o.uploaded ? new Date(o.uploaded) : new Date());
        const lh = new Uint8Array(30 + nameBytes.length);
        const v = new DataView(lh.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 0x0800, true);   // utf-8 names
        v.setUint16(8, 0, true);        // stored, no compression
        v.setUint16(10, st.t, true);
        v.setUint16(12, st.d, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, data.length, true);
        v.setUint32(22, data.length, true);
        v.setUint16(26, nameBytes.length, true);
        v.setUint16(28, 0, true);
        lh.set(nameBytes, 30);
        c.enqueue(lh);
        if (data.length) c.enqueue(data);
        central.push({ nameBytes, crc, size: data.length, st, offset });
        offset += lh.length + data.length;
        return;
      }
      let cdSize = 0;
      for (const e of central) {
        const b = new Uint8Array(46 + e.nameBytes.length);
        const v = new DataView(b.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, 0x0800, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, e.st.t, true);
        v.setUint16(14, e.st.d, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, e.size, true);
        v.setUint32(24, e.size, true);
        v.setUint16(28, e.nameBytes.length, true);
        v.setUint16(30, 0, true);
        v.setUint16(32, 0, true);
        v.setUint16(34, 0, true);
        v.setUint16(36, 0, true);
        v.setUint32(38, 0, true);
        v.setUint32(42, e.offset, true);
        b.set(e.nameBytes, 46);
        c.enqueue(b);
        cdSize += b.length;
      }
      const eo = new Uint8Array(22);
      const v2 = new DataView(eo.buffer);
      v2.setUint32(0, 0x06054b50, true);
      v2.setUint16(4, 0, true);
      v2.setUint16(6, 0, true);
      v2.setUint16(8, central.length, true);
      v2.setUint16(10, central.length, true);
      v2.setUint32(12, cdSize, true);
      v2.setUint32(16, offset, true);
      v2.setUint16(20, 0, true);
      c.enqueue(eo);
      c.close();
    },
  });
}
