// The Worker's HTTP surface, as five methods.
//
// `?info=1` is the only data feed there is — one tab-separated line, pins/used/
// quota at the root and name/size/date on a pin. Change nothing about how it is
// parsed here without changing the Worker in the same pass.

import { request as insecure } from "node:http";
import { request as secure } from "node:https";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";

export const DEFAULT_HOST = "https://files.dharun.dev";

const enc = encodeURIComponent;
const ok = (s) => s >= 200 && s < 300;

export class Api {
  constructor(host, pass) {
    this.host = String(host).replace(/\/+$/, "");
    this.pass = pass || "";
  }

  link(pin) { return this.host + "/" + enc(pin); }

  /** Anything with a small text response. `file` streams a body up. */
  call(path, { method = "GET", headers = {}, file, size, onProgress } = {}) {
    const u = new URL(this.host + path);
    const driver = u.protocol === "https:" ? secure : insecure;
    const h = { "x-pass": this.pass, "user-agent": "dropbin-cli", ...headers };
    if (file) h["content-length"] = String(size);
    return new Promise((resolve, reject) => {
      const req = driver(u, { method, headers: h }, (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () => resolve({
          status: res.statusCode,
          ok: ok(res.statusCode),
          body: Buffer.concat(chunks).toString("utf8").trim(),
        }));
      });
      req.on("error", (e) => reject(e));
      if (!file) return req.end();
      let sent = 0;
      const rs = createReadStream(file);
      rs.on("data", (b) => { sent += b.length; onProgress?.(sent, size); });
      rs.on("error", (e) => { req.destroy(); reject(e); });
      rs.pipe(req);
    });
  }

  /** Straight to disk, so a download is never held in memory. */
  save(path, dest, onProgress) {
    const u = new URL(this.host + path);
    const driver = u.protocol === "https:" ? secure : insecure;
    return new Promise((resolve, reject) => {
      const req = driver(u, { headers: { "x-pass": this.pass, "user-agent": "dropbin-cli" } }, (res) => {
        if (!ok(res.statusCode)) {
          const chunks = [];
          res.on("data", (b) => chunks.push(b));
          res.on("end", () => resolve({
            status: res.statusCode, ok: false,
            body: Buffer.concat(chunks).toString("utf8").trim(),
          }));
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let got = 0;
        const ws = createWriteStream(dest);
        res.on("data", (b) => { got += b.length; onProgress?.(got, total); });
        res.on("error", (e) => { ws.destroy(); unlink(dest).catch(() => {}); reject(e); });
        ws.on("error", (e) => { res.destroy(); reject(e); });
        ws.on("finish", () => resolve({ status: res.statusCode, ok: true, body: "" }));
        res.pipe(ws);
      });
      req.on("error", (e) => reject(e));
      req.end();
    });
  }

  /* ------------------------------------------------------------ the five -- */

  /** Storage, and the password check: 401 here means the password is wrong. */
  async info() {
    const r = await this.call("/?info=1");
    if (!r.ok) return r;
    const [pins, used, quota] = r.body.split("\t");
    return { ...r, pins: +pins || 0, used: +used || 0, quota: +quota || 0 };
  }

  /** What a pin holds, without fetching it. */
  async peek(pin) {
    const r = await this.call("/" + enc(pin) + "?info=1");
    if (!r.ok) return r;
    const [name, size, date] = r.body.split("\t");
    if (!name) return { ...r, ok: false };
    return { ...r, name, size: +size || 0, date: date || "" };
  }

  /** One object per pin: uploading over a pin replaces what it held. */
  async put(file, name, pin, onProgress) {
    const size = (await stat(file)).size;
    const r = await this.call("/up?quiet=1", {
      method: "PUT",
      headers: { "x-name": name, "x-pin": pin || "", "content-type": "application/octet-stream" },
      file, size, onProgress,
    });
    if (r.ok) r.pin = r.body.replace(/[\r\n]/g, "");
    return r;
  }

  get(pin, dest, onProgress) { return this.save("/" + enc(pin), dest, onProgress); }
  read(pin) { return this.call("/" + enc(pin) + "?view=1"); }
  remove(pin) { return this.call("/" + enc(pin), { method: "DELETE" }); }
}
