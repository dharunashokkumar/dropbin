// dropbin — the bucket, over S3.
//
// The rest of the code talks to a bucket through five calls: get, head, put,
// delete and list. This is those five over any S3 endpoint (Garage, MinIO,
// SeaweedFS, AWS), signed with SigV4 through crypto.subtle, so nothing else
// needs to know where the bytes live. Path-style URLs only:
// S3_ENDPOINT/S3_BUCKET/key, which every S3 server answers without DNS tricks.
//
// What a call hands back has the shape the router reads: `key`, `size`,
// `uploaded`, `httpMetadata.contentType`, and on a GET `body`, `range` and
// `httpEtag`. Nothing else is stored per object but the content type.

const te = new TextEncoder();
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // sha256("")

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(data) { return hex(await crypto.subtle.digest("SHA-256", data)); }
async function hmac(key, s) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, te.encode(s));
}

// RFC 3986, which is what SigV4 canonicalises with: encodeURIComponent leaves
// !'()* alone and S3 does not.
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function tag(xml, name) {
  const m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? m[1] : "";
}
function unxml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e.toLowerCase()];
  });
}

async function fail(r, what) {
  const body = await r.text().catch(() => "");
  const code = tag(body, "Code") || String(r.status);
  const msg = tag(body, "Message");
  return new Error("storage " + what + " failed: " + code + (msg ? " — " + unxml(msg) : ""));
}

function meta(key, r) {
  const type = r.headers.get("content-type") || undefined;
  const lm = r.headers.get("last-modified");
  return {
    key,
    size: Number(r.headers.get("content-length") || 0),
    uploaded: lm ? new Date(lm) : null,
    httpEtag: r.headers.get("etag") || "",
    httpMetadata: { contentType: type },
    writeHttpMetadata(h) { if (type) h.set("content-type", type); },
  };
}

export function bucket(env) {
  const ep = String(env.S3_ENDPOINT || "").replace(/\/+$/, "");
  const host = new URL(ep).host;
  const name = String(env.S3_BUCKET || "");
  const region = String(env.S3_REGION || "us-east-1");
  const id = String(env.S3_KEY_ID || ""), secret = String(env.S3_SECRET || "");

  async function call(method, key, { query = {}, headers = {}, body = null } = {}) {
    const path = "/" + enc(name) + (key === null ? "" : "/" + key.split("/").map(enc).join("/"));
    const qs = Object.keys(query).sort().map((k) => enc(k) + "=" + enc(String(query[k]))).join("&");
    const payload = body === null ? EMPTY : await sha256(body);
    const amz = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");   // 20261027T093000Z
    const day = amz.slice(0, 8);
    const h = { host, "x-amz-content-sha256": payload, "x-amz-date": amz };
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim();
    const names = Object.keys(h).sort();
    const canon = [method, path, qs, names.map((n) => n + ":" + h[n]).join("\n") + "\n", names.join(";"), payload].join("\n");
    const scope = day + "/" + region + "/s3/aws4_request";
    const sts = ["AWS4-HMAC-SHA256", amz, scope, await sha256(te.encode(canon))].join("\n");
    let k = await hmac(te.encode("AWS4" + secret), day);
    for (const part of [region, "s3", "aws4_request"]) k = await hmac(k, part);
    const sig = hex(await hmac(k, sts));
    const send = { ...h };
    delete send.host;   // fetch sets it from the URL, and it is the same value
    send.authorization = "AWS4-HMAC-SHA256 Credential=" + id + "/" + scope +
      ", SignedHeaders=" + names.join(";") + ", Signature=" + sig;
    return fetch(ep + path + (qs ? "?" + qs : ""), { method, headers: send, body });
  }

  return {
    async head(key) {
      const r = await call("HEAD", key);
      if (r.status === 404) return null;
      if (!r.ok) throw await fail(r, "HEAD");
      return meta(key, r);
    },

    // `range` is the request's Headers, as the router passes it: a Range header
    // there goes straight through, and S3 answers 206 with Content-Range.
    async get(key, opts = {}) {
      const want = opts.range && typeof opts.range.get === "function" ? opts.range.get("range") : null;
      let r = await call("GET", key, { headers: want ? { range: want } : {} });
      if (r.status === 416) {   // a range past the end: hand back the whole thing, as R2 did
        await r.body?.cancel();
        r = await call("GET", key);
      }
      if (r.status === 404) { await r.body?.cancel(); return null; }
      if (!r.ok) throw await fail(r, "GET");
      const o = meta(key, r);
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get("content-range") || "");
      if (r.status === 206 && cr) {
        o.size = Number(cr[3]);
        o.range = { offset: Number(cr[1]), length: Number(cr[2]) - Number(cr[1]) + 1 };
      }
      o.body = r.body;
      o.arrayBuffer = () => new Response(o.body).arrayBuffer();
      return o;
    },

    async put(key, body, opts = {}) {
      const headers = {};
      const t = opts.httpMetadata && opts.httpMetadata.contentType;
      if (t) headers["content-type"] = t;
      for (const [k, v] of Object.entries(opts.customMetadata || {})) headers["x-amz-meta-" + k] = v;
      const r = await call("PUT", key, { headers, body });
      if (!r.ok) throw await fail(r, "PUT");
      await r.body?.cancel();
    },

    // One key or a list of them. A pin holds one object, so a request per key
    // costs nothing and skips DeleteObjects' XML and Content-MD5.
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const r = await call("DELETE", key);
        if (!r.ok && r.status !== 404) throw await fail(r, "DELETE");
        await r.body?.cancel();
      }
    },

    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const query = { "list-type": "2", "max-keys": String(limit) };
      if (prefix) query.prefix = prefix;
      if (cursor) query["continuation-token"] = cursor;
      const r = await call("GET", null, { query });
      if (!r.ok) throw await fail(r, "LIST");
      const xml = await r.text();
      const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => {
        const lm = tag(c, "LastModified");
        return { key: unxml(tag(c, "Key")), size: Number(tag(c, "Size")), uploaded: lm ? new Date(lm) : null };
      });
      const truncated = tag(xml, "IsTruncated") === "true";
      return { objects, truncated, cursor: truncated ? unxml(tag(xml, "NextContinuationToken")) : undefined };
    },
  };
}
