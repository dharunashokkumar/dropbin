// A QR code for a link, printed in the terminal — for handing a file to a
// phone. Byte mode, error correction level M, versions 1-15; that covers any
// link this tool produces with room to spare. No dependency: the whole encoder
// is here, and it is the only clever code in the package.

const SPEC = { // version: [ec codewords per block, [[blocks, data codewords], ...]]
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
  5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]], 11: [30, [[1, 50], [4, 51]]],
  12: [22, [[6, 36], [2, 37]]], 13: [22, [[8, 37], [1, 38]]], 14: [24, [[4, 40], [5, 41]]],
  15: [24, [[5, 41], [5, 42]]],
};
const ALIGN = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
  8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};

/* ------------------------------------------------------------- GF(256) --- */

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x = x << 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const q = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) { q[j] ^= p[j]; q[j + 1] ^= mul(p[j], EXP[i]); }
    p = q;
  }
  return p;
}

function remainder(data, n) {
  const g = generator(n);
  const r = new Uint8Array(data.length + n);
  r.set(data);
  for (let i = 0; i < data.length; i++) {
    const f = r[i];
    if (!f) continue;
    for (let j = 1; j < g.length; j++) r[i + j] ^= mul(g[j], f);
  }
  return r.slice(data.length);
}

/* -------------------------------------------------------- bits and bytes --- */

function bitLen(n) { let l = 0; while (n !== 0) { l++; n >>>= 1; } return l; }

function formatBits(mask) {          // level M is 0b00, so the data is the mask
  const data = mask;
  let d = data << 10;
  while (bitLen(d) - 11 >= 0) d ^= 0x537 << (bitLen(d) - 11);
  return ((data << 10) | d) ^ 0x5412;
}

function versionBits(v) {
  let d = v << 12;
  while (bitLen(d) - 13 >= 0) d ^= 0x1f25 << (bitLen(d) - 13);
  return (v << 12) | d;
}

function codewords(bytes, version) {
  const [ec, groups] = SPEC[version];
  const total = groups.reduce((a, [c, d]) => a + c * d, 0);
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };

  push(4, 4);                                     // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, total * 8 - bits.length));  // terminator
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    words.push(b);
  }
  for (let i = 0; words.length < total; i++) words.push(i % 2 ? 0x11 : 0xec);

  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const d = Uint8Array.from(words.slice(at, at + size));
      at += size;
      blocks.push({ d, e: remainder(d, ec) });
    }
  }

  const wide = Math.max(...blocks.map((b) => b.d.length));
  const out = [];
  for (let i = 0; i < wide; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/* ----------------------------------------------------------- the matrix --- */

const MASK = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

function build(version, data, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (y, x, v) => { if (y >= 0 && x >= 0 && y < size && x < size) m[y][x] = v; };

  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const ring = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
          (j >= 0 && j <= 6 && (i === 0 || i === 6));
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        set(r + i, c + j, ring || core);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

  const pos = ALIGN[version] || [];
  const last = pos[pos.length - 1];
  for (const r of pos) {
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
      }
    }
  }

  set(size - 8, 8, true);                         // the dark module

  const fmt = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const on = ((fmt >> i) & 1) === 1;
    if (i < 6) set(i, 8, on);
    else if (i < 8) set(i + 1, 8, on);
    else set(size - 15 + i, 8, on);
    if (i < 8) set(8, size - i - 1, on);
    else if (i < 9) set(8, 15 - i, on);
    else set(8, 14 - i, on);
  }
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((vb >> i) & 1) === 1;
      set(Math.floor(i / 3), (i % 3) + size - 11, on);
      set((i % 3) + size - 11, Math.floor(i / 3), on);
    }
  }

  let row = size - 1, up = true, byte = 0, bit = 7;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] !== null) continue;
        let on = byte < data.length ? ((data[byte] >>> bit) & 1) === 1 : false;
        if (MASK[mask](row, col - c)) on = !on;
        m[row][col - c] = on;
        bit -= 1;
        if (bit < 0) { byte++; bit = 7; }
      }
      row += up ? -1 : 1;
      if (row < 0 || row >= size) { row -= up ? -1 : 1; up = !up; break; }
    }
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  const runs = (get) => {
    let run = 1, prev = get(0), s = 0;
    for (let i = 1; i < n; i++) {
      const v = get(i);
      if (v === prev) { run++; continue; }
      if (run >= 5) s += 3 + (run - 5);
      run = 1; prev = v;
    }
    return run >= 5 ? s + 3 + (run - 5) : s;
  };
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const hit = (get, i, rev) => {
    for (let k = 0; k < 11; k++) if ((get(i + k) ? 1 : 0) !== PAT[rev ? 10 - k : k]) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    const row = (k) => m[i][k], col = (k) => m[k][i];
    p += runs(row) + runs(col);
    for (let j = 0; j <= n - 11; j++) {
      if (hit(row, j, false) || hit(row, j, true)) p += 40;
      if (hit(col, j, false) || hit(col, j, true)) p += 40;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3;
    }
  }
  let dark = 0;
  for (const r of m) for (const v of r) if (v) dark++;
  return p + 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
}

/**
 * The modules, mask chosen the way the spec says: lowest penalty wins. `force`
 * pins the mask instead, which is how this gets diffed against another encoder.
 */
export function encode(text, force) {
  const bytes = Buffer.from(String(text), "utf8");
  let version = 0;
  for (let v = 1; v <= 15; v++) {
    const total = SPEC[v][1].reduce((a, [c, d]) => a + c * d, 0);
    if (bytes.length <= total - (v < 10 ? 2 : 3)) { version = v; break; }
  }
  if (!version) throw new Error("too long for a terminal QR code");

  const data = codewords(bytes, version);
  if (force !== undefined) return build(version, data, force);
  let best = null, score = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, data, mask);
    const p = penalty(m);
    if (p < score) { score = p; best = m; }
  }
  return best;
}

/**
 * Half blocks: one column per module, two module rows per printed row, which
 * comes out square in a terminal. Colour forces black on white so it scans on
 * a dark theme too; without colour the modules are drawn in the foreground
 * colour, so that path needs a light background to read.
 */
export function render(text, { colour = true, quiet = 2 } = {}) {
  const m = encode(text);
  const n = m.length, w = n + quiet * 2;
  const at = (y, x) =>
    y >= quiet && y < quiet + n && x >= quiet && x < quiet + n ? !!m[y - quiet][x - quiet] : false;
  const lines = [];
  for (let y = 0; y < w; y += 2) {
    let s = "";
    for (let x = 0; x < w; x++) {
      const top = at(y, x), bottom = at(y + 1, x);
      s += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(colour ? "\x1b[30;47m" + s + "\x1b[0m" : s);
  }
  return lines.join("\n");
}
