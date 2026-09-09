// dropbin — routing.
//
// Two things happen here, and nothing else:
//
//   upload    PUT /up  or  POST /up   ->  a pin
//   download  GET /PIN                ->  the one thing that pin holds
//
// There is no listing, anywhere. A pin holds one object; a folder was already
// zipped by the client before it arrived, so it is one object too.
//
//   GET  /              the two options, plus how much room is left
//   GET  /upload /get   the browser's two dialogs
//   GET  /PIN           a browser previews it; everything else downloads it
//                       (?view=1 the bytes inline, ?dl=1 save it,
//                        ?info=1 name/size/date, ?k= a signed link)
//   PUT  /up  POST /up  upload     (X-Pin / ?pin= / form field, else a new pin)
//   DEL  /PIN           throw it away and get the space back
//   GET  /cli /cli.ps1  the terminal client, pre-pointed at this host
//   GET  /install.sh /install.ps1   the `db` installer, same placeholder
//
// Browsers get HTML, curl gets plain text, and both come from the same route.
// Everything except the two clients, the two installers, /robots.txt and
// /favicon.ico needs the password — or,
// for one pin and read-only, the `?k=` a share link carries.

import {
  BASE, authed, cleanName, csize, eq, fmt, guessType, hsize, html, json, newPin,
  pinItems, pinOk, quota, shared, text, token, usage, when, zipLimit, zipStream,
} from "./util.js";
import { getPage, homePage, loginPage, uploadPage, viewPage } from "./ui.js";
import shScript from "./drop.sh";
import psScript from "./drop.ps1";
import shInstall from "../install.sh";
import psInstall from "../install.ps1";

const RESERVED = new Set([
  "api", "cli", "cli.ps1", "up", "upload", "get", "www", "assets", "static",
  "favicon.ico", "robots.txt", "install.sh", "install.ps1",
]);

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#1f6feb"/>' +
  '<path d="M16 7v13m0 0l-5-5m5 5l5-5M8 25h16" stroke="#fff" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

function dec(s) { try { return decodeURIComponent(s); } catch { return s; } }
function pinUrl(origin, pin) { return origin + "/" + encodeURIComponent(pin); }

function needAuth(url, f) {
  if (f === "html") return html(loginPage(url.pathname + url.search), 401);
  if (f === "json") return json({ error: "password required" }, 401);
  return text(
    "401 — password required\n\n" +
    '  curl "' + url.origin + url.pathname + '?p=YOUR_PASSWORD"\n' +
    '  curl -H "X-Pass: YOUR_PASSWORD" ' + url.origin + url.pathname + "\n", 401);
}

function gone(f, what) {
  if (f === "json") return json({ error: what }, 404);
  if (f === "html") {
    return html("<!doctype html><meta charset=utf-8><title>404</title>" +
      "<body style='font:13px ui-monospace,monospace;padding:24px'>" +
      "<h1 style='font-size:16px'>404 — " + what + "</h1><hr>" +
      "<p><a href='/'>dropbin</a></p>", 404);
  }
  return text("404 — " + what, 404);
}

/* ----------------------------------------------------------------- home --- */

// The only number this tool reports: how much room is left.
async function home(req, url, env, f) {
  const { used, pins } = await usage(env);
  const cap = quota(env);
  const free = Math.max(0, cap - used);

  if (url.searchParams.get("info") === "1") {
    return text(pins + "\t" + used + "\t" + cap);
  }
  if (f === "json") return json({ pins, used, free, quota: cap });
  if (f === "html") return html(homePage(url.origin, url.host, used, cap, pins));

  return text(
    "dropbin — " + url.host + "\n\n" +
    "  upload    curl -T ./file.png \"" + url.protocol + "//:$PASS@" + url.host + "/up/\"\n" +
    "  download  curl -OJ \"" + url.origin + "/PIN?p=$PASS\"\n\n" +
    "  " + pins + (pins === 1 ? " pin · " : " pins · ") + hsize(used) + " used · " +
    hsize(free) + " free of " + hsize(cap) + "\n\n" +
    "  install     curl -fsSL " + url.origin + "/install.sh | sh   then: db\n" +
    "  on windows  irm " + url.origin + "/install.ps1 | iex\n" +
    "  with npm    npm i -g dropbin\n" +
    "  or once     curl -s " + url.origin + "/cli -o drop && bash drop\n");
}

/* ------------------------------------------------------------- download --- */

// Everything a pin holds, collapsed to one downloadable thing.
// One object is the normal case; several means an old pin, and those get zipped.
async function pinFind(env, pin) {
  const objs = await pinItems(env, pin);
  if (!objs.length) return null;
  if (objs.length === 1) {
    const o = objs[0];
    return { one: o, name: o.key.slice(pin.length + 1).split("/").pop() || pin,
      size: o.size, at: o.uploaded ? new Date(o.uploaded) : null };
  }
  const size = objs.reduce((a, o) => a + o.size, 0);
  const at = objs.reduce((a, o) => (o.uploaded && (!a || o.uploaded > a) ? o.uploaded : a), null);
  return { many: objs, name: pin + ".zip", size, at: at ? new Date(at) : null };
}

// What to call the bytes when they are being looked at rather than saved. The
// stored type only wins if it says something: `db` PUTs everything as
// application/octet-stream, and under `nosniff` a vague type is a blank preview
// rather than a guess.
function viewType(name, stored) {
  const s = String(stored || "").split(";")[0].trim().toLowerCase();
  return s && s !== "application/octet-stream" ? s : guessType(name);
}

function serveHeaders(name, view) {
  const h = new Headers(BASE);
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "sandbox"); // an uploaded html/svg can't touch this origin
  h.set("content-disposition",
    (view ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(name));
  return h;
}

async function serveOne(req, env, obj, name, view) {
  if (req.method === "HEAD") {
    const h = serveHeaders(name, view);
    h.set("content-length", String(obj.size));
    h.set("accept-ranges", "bytes");
    h.set("content-type", view ? viewType(name, obj.httpMetadata && obj.httpMetadata.contentType)
      : "application/octet-stream");
    return new Response(null, { headers: h });
  }

  const got = await env.BUCKET.get(obj.key, { range: req.headers });
  if (!got) return text("404 — gone while reading it", 404);

  const h = serveHeaders(name, view);
  got.writeHttpMetadata(h);
  h.set("etag", got.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("content-type", view
    ? viewType(name, got.httpMetadata && got.httpMetadata.contentType)
    : "application/octet-stream");
  // writeHttpMetadata can put the stored disposition back; ours wins.
  h.set("content-disposition",
    (view ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(name));

  let status = 200;
  if (got.range && req.headers.get("range")) {
    const off = got.range.offset || 0;
    const len = got.range.length === undefined ? got.size - off : got.range.length;
    h.set("content-range", "bytes " + off + "-" + (off + len - 1) + "/" + got.size);
    h.set("content-length", String(len));
    status = 206;
  }
  return new Response(got.body, { status, headers: h });
}

// Old multi-object pins only. Zipping costs CPU, so it is capped.
function serveMany(env, pin, hit) {
  const budget = zipLimit(env);
  if (hit.size > budget) {
    return text(
      "pin " + pin + " is an old multi-file pin holding " + hsize(hit.size) + ", and\n" +
      "zipping is capped at " + hsize(budget) + " of CPU. Fetch the pieces directly:\n" +
      hit.many.map((o) => "  /" + o.key).join("\n") + "\n", 413);
  }
  return new Response(zipStream(env, hit.many, pin.length + 1), {
    headers: { ...BASE, "content-type": "application/zip",
      "content-disposition": 'attachment; filename="' + pin + '.zip"' },
  });
}

async function download(req, url, env, pin, f, key) {
  const hit = await pinFind(env, pin);
  if (!hit) return gone(f, "no such pin: " + pin);
  const view = url.searchParams.get("view") === "1";

  // What is behind this pin, without fetching it. The CLI asks before it saves.
  if (url.searchParams.get("info") === "1" || f === "json") {
    const meta = { pin, name: hit.name, size: hit.size,
      at: hit.at ? hit.at.toISOString() : null, url: pinUrl(url.origin, pin) };
    if (f === "json") return json(meta);
    return text(hit.name + "\t" + hit.size + "\t" + when(hit.at));
  }

  // A browser looks at the thing first and only saves it if it asks to; every
  // other client — curl, `db get`, the shell clients — still gets the bytes.
  if (f === "html" && !view && url.searchParams.get("dl") !== "1") {
    return html(viewPage(url.origin, pin, hit, key));
  }

  if (hit.many) return serveMany(env, pin, hit);
  return serveOne(req, env, hit.one, hit.name, view);
}

/* --------------------------------------------------------------- upload --- */

async function upload(req, url, env, tail, f) {
  if (req.method !== "POST" && req.method !== "PUT") {
    return text("use PUT (raw body) or POST (multipart)", 405, { allow: "PUT, POST" });
  }
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  // curl only appends the local filename to a URL that ends in "/" *and* carries
  // no query string, hence the header forms:
  //   curl -T ./a.png -H "X-Pin: notes" "https://:PASS@host/up/"
  let pin = (url.searchParams.get("pin") || req.headers.get("x-pin") || "").trim();
  let name = "", body = null, type = "";

  if (req.method === "POST" && ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    const p = fd.get("pin");
    if (typeof p === "string" && p.trim()) pin = p.trim();
    const files = [...fd.values()].filter((v) => typeof v !== "string");
    if (files.length > 1) {
      return text("one thing per pin — pack them into a zip first", 400);
    }
    if (files.length) {
      name = cleanName(files[0].name || "file");
      body = await files[0].arrayBuffer();
      type = files[0].type || guessType(name);
    }
  } else {
    name = cleanName(
      req.headers.get("x-name") || url.searchParams.get("name") || tail.join("/") || "file");
    // `db` and `curl -T` both send octet-stream; the name knows better.
    type = viewType(name, ct.includes("x-www-form-urlencoded") ? "" : ct);
    body = await req.arrayBuffer();
  }

  if (body === null) return text("nothing to upload", 400);

  if (pin) {
    if (!pinOk(pin) || RESERVED.has(pin.toLowerCase())) {
      return text("bad pin — anything you like, up to 64 characters, no slashes", 400);
    }
  } else {
    pin = await newPin(env);
  }

  // One pin, one thing: reusing a pin replaces what was there.
  const old = await pinItems(env, pin);
  for (let i = 0; i < old.length; i += 100) {
    await env.BUCKET.delete(old.slice(i, i + 100).map((o) => o.key));
  }

  await env.BUCKET.put(pin + "/" + name, body, {
    httpMetadata: { contentType: type || "application/octet-stream" },
    customMetadata: { at: new Date().toISOString() },
  });

  const link = pinUrl(url.origin, pin);
  const replaced = old.length > 0;
  if (url.searchParams.get("quiet") === "1") return text(pin);
  if (f === "json") return json({ pin, name, size: body.byteLength, url: link, replaced });
  // A plain <form> post from a browser with JavaScript off.
  if (f === "html") {
    return new Response(null, {
      status: 303,
      headers: { ...BASE, location: "/get?pin=" + encodeURIComponent(pin) + "&new=1" },
    });
  }
  return text(
    "uploaded" + (replaced ? " (replaced what pin " + pin + " held)" : "") + "\n\n" +
    "  pin   " + pin + "\n" +
    "  file  " + name + "  " + csize(body.byteLength) + "\n" +
    "  url   " + link + "\n");
}

/* --------------------------------------------------------------- router --- */

async function route(req, env) {
  const url = new URL(req.url);
  const segs = url.pathname.split("/").filter(Boolean).map(dec);
  const f = fmt(req, url);
  const head = segs[0];

  // Public: no password, and no data behind them.
  if (head === "robots.txt") return text("User-agent: *\nDisallow: /");
  if (head === "favicon.ico") {
    return new Response(ICON, {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    });
  }
  if (head === "cli") return text(shScript.split("__HOST__").join(url.origin));
  if (head === "cli.ps1") return text(psScript.split("__HOST__").join(url.origin));
  // The installers carry the same placeholder, so the `db` they leave behind
  // talks to this deployment without having to be told to.
  if (head === "install.sh") return text(shInstall.split("__HOST__").join(url.origin));
  if (head === "install.ps1") return text(psInstall.split("__HOST__").join(url.origin));

  if (head === "api" && segs[1] === "login") {
    if (req.method !== "POST") return html(loginPage("/"));
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    let pass = "", next = "/";
    if (ct.includes("json")) {
      const b = await req.json().catch(() => ({}));
      pass = String(b.pass || "");
      next = String(b.next || "/");
    } else {
      const fd = await req.formData();
      pass = String(fd.get("pass") || "");
      next = String(fd.get("next") || "/");
    }
    if (!next.startsWith("/")) next = "/";
    const want = env.ACCESS_PASSWORD || "changeme";
    if (!eq(pass, want)) return html(loginPage(next, true), 401);
    const secure = url.protocol === "https:" ? " Secure;" : "";
    return new Response(null, {
      status: 303,
      headers: {
        ...BASE, location: next,
        "set-cookie": "dp=" + (await token(want)) + "; Path=/; HttpOnly;" + secure +
          " SameSite=Lax; Max-Age=31536000",
      },
    });
  }
  if (head === "api" && segs[1] === "logout") {
    return new Response(null, {
      status: 303,
      headers: { ...BASE, location: "/", "set-cookie": "dp=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" },
    });
  }

  // Everything below needs the password — or, for exactly one pin and read-only,
  // the signature a share link carries. `db open` and `db qr` hand their link to
  // a browser or a phone, and neither of those can be asked for a password.
  if (!(await authed(req, url, env))) {
    const one = segs.length === 1 ? segs[0] : "";
    if (!one || !pinOk(one) || RESERVED.has(one.toLowerCase()) || !(await shared(url, env, one))) {
      return needAuth(url, f);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return text("this link only reads pin " + one, 405, { allow: "GET, HEAD" });
    }
    return download(req, url, env, one, f, url.searchParams.get("k"));
  }

  if (head === "up") return upload(req, url, env, segs.slice(1), f);
  if (head === "api") return gone(f, "unknown endpoint");
  if (!segs.length) return home(req, url, env, f);

  // The browser's two dialogs. Everything they do is available over plain HTTP.
  if (head === "upload") return html(uploadPage());
  if (head === "get") {
    const want = (url.searchParams.get("pin") || "").trim();
    if (!want) return html(getPage(url.origin, null));
    const hit = pinOk(want) ? await pinFind(env, want) : null;
    return html(getPage(url.origin, want, hit, url.searchParams.get("new") === "1"));
  }

  if (!pinOk(head) || RESERVED.has(head.toLowerCase())) return gone(f, "bad pin: " + head);

  if (req.method === "DELETE") {
    const all = await pinItems(env, head);
    if (!all.length) return gone(f, "no such pin: " + head);
    for (let i = 0; i < all.length; i += 100) {
      await env.BUCKET.delete(all.slice(i, i + 100).map((o) => o.key));
    }
    if (f === "json") return json({ ok: true, pin: head, deleted: all.length });
    return text("deleted pin " + head);
  }

  // A path below the pin only exists on old multi-file pins; serve it if it is real.
  if (segs.length > 1) {
    const key = segs.join("/");
    const h = await env.BUCKET.head(key);
    if (!h) return gone(f, "no such file: /" + key);
    const name = segs[segs.length - 1];
    return serveOne(req, env, h, name, url.searchParams.get("view") === "1");
  }

  return download(req, url, env, head, f, null);
}

export default {
  async fetch(req, env) {
    if (!env.BUCKET) return text("R2 bucket binding 'BUCKET' is missing — check wrangler.toml", 500);
    try {
      return await route(req, env);
    } catch (e) {
      return text("500 — " + (e && e.message ? e.message : String(e)), 500);
    }
  },
};
