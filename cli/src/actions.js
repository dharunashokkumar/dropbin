// The work itself, written once and shared by the menu and the flat commands.
// Each action throws an Error carrying a sentence the user can read; nothing
// here prints a summary — the caller decides how loud to be.

import { basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bar, human, say, D, Z } from "./term.js";
import { zipDir } from "./zip.js";

/**
 * What a human pastes into a prompt: surrounding quotes, a leading ~, and — on
 * Windows — a Git Bash path, because `db up $(pwd)/x` there hands us /c/Users/…
 * which Node would otherwise resolve against the current drive root.
 */
export function expand(p) {
  let s = String(p || "").trim().replace(/^(['"])(.*)\1$/, "$2");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = join(homedir(), s.slice(1));
  if (process.platform === "win32") {
    const msys = /^\/([A-Za-z])(\/|$)/.exec(s);
    if (msys) s = msys[1] + ":/" + s.slice(3);
  }
  return s;
}

/** Never overwrite: a second copy of holiday.png becomes holiday.png.1 */
export function unused(path) {
  if (!existsSync(path)) return path;
  for (let n = 1; ; n++) if (!existsSync(path + "." + n)) return path + "." + n;
}

async function kind(path) {
  try {
    const st = await stat(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

/** Resolve what the user typed, before anything else is asked of them. */
export async function inspect(path, want) {
  const p = resolve(expand(path));
  const what = await kind(p);
  if (!what) throw new Error("no such file or folder: " + p);
  if (what === "other") throw new Error("not a regular file or folder: " + p);
  if (want && want !== what) throw new Error(`not a ${want === "dir" ? "folder" : "file"}: ${p}`);
  const size = what === "file" ? (await stat(p)).size : 0;
  return { path: p, type: what, name: basename(p), size };
}

/**
 * Upload a file, or a folder zipped first. Returns { pin, name, size, link }.
 * The zip is built in a temp directory and removed before this returns.
 */
export async function send(api, path, pin) {
  const it = await inspect(path);
  const p = it.path, what = it.type;

  let file = p, name = it.name, scratch = null;
  try {
    if (what === "dir") {
      scratch = await mkdtemp(join(tmpdir(), "dropbin-"));
      name = (basename(p) || "folder") + ".zip";
      file = join(scratch, name);
      const packing = bar(`${D}packing${Z}`);
      await zipDir(p, file, (done, total) => packing.tick(done, total));
      packing.end();
    }
    const size = (await stat(file)).size;
    const sending = bar(`sending ${name}`);
    const r = await api.put(file, name, pin, (sent, total) => sending.tick(sent, total));
    sending.end();
    if (!r.ok) throw new Error(`upload failed (HTTP ${r.status}): ${r.body || "no response"}`);
    return { pin: r.pin, name, size, link: api.link(r.pin) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** What a pin holds. Throws if the pin is empty. */
export async function look(api, pin) {
  const r = await api.peek(pin);
  if (r.status === 404 || (r.ok === false && r.status === 200)) {
    throw new Error(`no file found for pin '${pin}'`);
  }
  if (!r.ok) throw new Error(`could not read pin '${pin}' (HTTP ${r.status}): ${r.body || ""}`);
  return { name: r.name, size: r.size, date: r.date, link: api.link(pin) };
}

/** Download into `dir` (default: here). Returns the path written. */
export async function receive(api, pin, dir = ".") {
  const hit = await look(api, pin);
  const target = resolve(expand(dir));
  if ((await kind(target)) !== "dir") throw new Error("destination folder does not exist: " + target);
  const out = unused(join(target, hit.name));
  const saving = bar(`saving ${hit.name}`);
  const r = await api.get(pin, out, (got, total) => saving.tick(got, total));
  saving.end();
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status}): ${r.body || "no response"}`);
  return { path: out, ...hit };
}

/** Print the summary block that follows an upload. */
export function report(up, { copied } = {}) {
  say("");
  say(`  pin    ${up.pin}`);
  say(`  file   ${up.name}   ${human(up.size)}`);
  say(`  link   ${up.link}${copied ? `   ${D}(copied)${Z}` : ""}`);
}
