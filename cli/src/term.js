// Terminal side of the client: colour, sizes, prompts, progress.
//
// Everything the user reads goes to stderr; stdout carries only the one thing
// a script would want to capture (a pin, a path, a link), so `db up x` can be
// piped without the chatter coming along.
//
// A menu built on a line reader spins forever once stdin runs dry, so every
// prompt here returns null at end of input and every caller treats that as
// "quit". Test with `db < /dev/null`.

import { createInterface } from "node:readline";

const colour = !!process.stderr.isTTY && !process.env.NO_COLOR;
const c = (s) => (colour ? s : "");
export const B = c("\x1b[1m"), D = c("\x1b[2m"), R = c("\x1b[31m"),
  G = c("\x1b[32m"), Z = c("\x1b[0m");

export const say = (s = "") => void process.stderr.write(s + "\n");
export const out = (s) => void process.stdout.write(s + "\n");
export const err = (s) => say(`${R}Error:${Z} ${s}`);

export function human(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(2)) + " " + u[i];
}

export function banner(host) {
  say("");
  say(`${B}dropbin${Z}  ${D}${host.replace(/^https?:\/\//, "")}${Z}`);
  say(`${D}${"-".repeat(62)}${Z}`);
}

/* ---------------------------------------------------------------- input --- */

let rl = null, buffered = [], waiting = [], ended = false;

function reader() {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, terminal: !!process.stdin.isTTY });
  rl.on("line", (l) => { const w = waiting.shift(); w ? w(l) : buffered.push(l); });
  rl.on("close", () => { ended = true; while (waiting.length) waiting.shift()(null); });
  rl.on("SIGINT", () => { say(""); process.exit(130); });
  return rl;
}

// Let the process exit once we stop asking questions.
export function release() { if (rl) { rl.close(); rl = null; } }

const tidy = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/** One line, or null at end of input. */
export function ask(prompt) {
  reader();
  process.stderr.write(prompt);
  if (buffered.length) return Promise.resolve(tidy(buffered.shift()));
  if (ended) { say(""); return Promise.resolve(null); }
  return new Promise((r) => waiting.push((l) => r(l === null ? null : tidy(l))));
}

/** Re-asks until the answer is one of `keys`. Null at end of input. */
export async function choice(prompt, keys) {
  for (;;) {
    const v = await ask(prompt);
    if (v === null) return null;
    const k = v.toLowerCase();
    if (keys.includes(k)) return k;
    err("Please enter one of: " + keys.join(" "));
  }
}

/** A line with no echo. Falls back to a plain read when stdin is a pipe. */
export function secret(prompt) {
  const fd = process.stdin;
  if (!fd.isTTY) return ask(prompt);
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let v = "";
    const stop = () => { fd.setRawMode(false); fd.pause(); fd.off("data", onData); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { stop(); say(""); return resolve(v); }
        if (ch === "\x03") { stop(); say(""); process.exit(130); }        // ctrl-c
        if (ch === "\x04") { stop(); say(""); return resolve(v || null); } // ctrl-d
        if (ch === "\x7f" || ch === "\b") { v = v.slice(0, -1); continue; }
        if (ch >= " ") v += ch;
      }
    };
    fd.setRawMode(true); fd.resume(); fd.setEncoding("utf8");
    fd.on("data", onData);
  });
}

/* ------------------------------------------------------------- progress --- */

/** A bar on a tty, silence anywhere else. */
export function bar(label) {
  let at = 0, shown = false;
  const draw = (n, total) => {
    const w = 26;
    const pct = total > 0 ? Math.min(1, n / total) : 0;
    const full = Math.round(pct * w);
    const tail = total > 0
      ? String(Math.round(pct * 100)).padStart(3) + "%  " + human(n)
      : human(n);
    process.stderr.write("\r" + label + " [" + "=".repeat(full) +
      " ".repeat(w - full) + "] " + tail + "  ");
    shown = true;
  };
  return {
    tick(n, total) {
      if (!colour) return;
      const now = Date.now();
      if (now - at < 90 && n !== total) return;
      at = now; draw(n, total);
    },
    end() { if (shown) process.stderr.write("\r\x1b[K"); shown = false; },
  };
}
