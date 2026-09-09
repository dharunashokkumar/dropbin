// Client-side zip. A folder becomes one object before it is sent, because a
// free-plan Worker gets 10 ms of CPU per request and CRC32 alone costs ~1.4 ms
// per MB — the server must never see a folder.
//
// Written with node:zlib and nothing else, so `db` does not care whether zip,
// tar or Compress-Archive happens to be installed. Deflate is streamed and the
// local header is patched afterwards (no data descriptors), which keeps the
// archive readable by Windows Explorer as well as by unzip.


import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createDeflateRaw } from "node:zlib";
import { once } from "node:events";
import { basename, join, resolve } from "node:path";

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dos(when) {
  const d = when instanceof Date && !isNaN(when) ? when : new Date();
  const y = Math.max(1980, d.getFullYear());
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/** Every regular file and directory under `dir`, named relative to its parent. */
async function walk(dir) {
  const root = resolve(dir);
  const top = basename(root) || "folder";
  const items = [];
  let bytes = 0;

  async function visit(abs, rel) {
    items.push({ abs, name: rel + "/", dir: true, size: 0 });
    const kids = (await readdir(abs, { withFileTypes: true }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const k of kids) {
      const p = join(abs, k.name);
      const r = rel + "/" + k.name;
      const st = await lstat(p);
      if (st.isSymbolicLink()) continue;                 // no loops, no surprises
      if (st.isDirectory()) { await visit(p, r); continue; }
      if (!st.isFile()) continue;
      items.push({ abs: p, name: r, dir: false, size: st.size, at: st.mtime });
      bytes += st.size;
    }
  }

  await visit(root, top);
  return { items, bytes, top };
}

/**
 * Zip `dir` into `dest`. onProgress(done, total) counts uncompressed bytes.
 * Returns the number of bytes written.
 */
export async function zipDir(dir, dest, onProgress) {
  const { items, bytes } = await walk(dir);
  if (bytes > 0xfffffffe) throw new Error("folder is larger than 4 GB — zip it yourself first");

  const fh = await open(dest, "w");
  let pos = 0, done = 0;
  const put = async (b) => { await fh.write(b, 0, b.length, pos); pos += b.length; };
  const central = [];

  try {
    for (const it of items) {
      const name = Buffer.from(it.name, "utf8");
      const { date, time } = dos(it.at);
      const offset = pos;
      const method = it.dir ? 0 : 8;

      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);            // version needed
      local.writeUInt16LE(0x0800, 6);        // names are UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt16LE(name.length, 26);
      name.copy(local, 30);
      await put(local);

      let crc = 0, raw = 0, comp = 0;
      if (!it.dir) {
        const deflate = createDeflateRaw({ level: 6 });
        const feed = (async () => {
          for await (const chunk of createReadStream(it.abs)) {
            crc = crc32(chunk, crc);
            raw += chunk.length;
            done += chunk.length;
            onProgress?.(done, bytes);
            if (!deflate.write(chunk)) await once(deflate, "drain");
          }
          deflate.end();
        })();
        for await (const chunk of deflate) { comp += chunk.length; await put(chunk); }
        await feed;

        const patch = Buffer.alloc(12);
        patch.writeUInt32LE(crc, 0);
        patch.writeUInt32LE(comp, 4);
        patch.writeUInt32LE(raw, 8);
        await fh.write(patch, 0, 12, offset + 14);
      }

      const dir32 = Buffer.alloc(46 + name.length);
      dir32.writeUInt32LE(0x02014b50, 0);
      dir32.writeUInt16LE(0x031e, 4);        // made by unix, so the mode below counts
      dir32.writeUInt16LE(20, 6);
      dir32.writeUInt16LE(0x0800, 8);
      dir32.writeUInt16LE(method, 10);
      dir32.writeUInt16LE(time, 12);
      dir32.writeUInt16LE(date, 14);
      dir32.writeUInt32LE(crc, 16);
      dir32.writeUInt32LE(comp, 20);
      dir32.writeUInt32LE(raw, 24);
      dir32.writeUInt16LE(name.length, 28);
      dir32.writeUInt32LE(it.dir ? (0o755 << 16) | 0x10 : 0o644 << 16, 38);
      dir32.writeUInt32LE(offset, 42);
      name.copy(dir32, 46);
      central.push(dir32);
    }

    const start = pos;
    for (const b of central) await put(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(pos - start, 12);
    end.writeUInt32LE(start, 16);
    await put(end);
  } finally {
    await fh.close();
  }
  return pos;
}
