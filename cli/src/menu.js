// The menu. Two options and no more — the same shape the shell client has, so
// nobody has to learn this tool twice. Delete is not on it on purpose; it lives
// only in `db rm`.
//
// Every prompt returns null at end of input, and null means quit. Without that
// the loop would redraw forever the moment stdin ran dry.

import { ask, banner, choice, err, human, say, B, D, G, Z } from "./term.js";
import { inspect, look, receive, report, send } from "./actions.js";
import { copy } from "./sys.js";

async function storage(api) {
  const r = await api.info();
  if (!r.ok) return null;
  return `${D}Storage: ${human(Math.max(0, r.quota - r.used))} free of ` +
    `${human(r.quota)} · ${r.pins} pin${r.pins === 1 ? "" : "s"} stored${Z}`;
}

async function upload(api, opts) {
  banner(api.host);
  say(`${B}Upload${Z}`);
  say("  [1] File");
  say(`  [2] Folder ${D}(zipped before it is sent)${Z}`);
  say("  [b] Back");
  const what = await choice("\nChoice: ", ["1", "2", "b"]);
  if (what === null) return false;
  if (what === "b") return true;

  const path = await ask(`Path to the ${what === "1" ? "file" : "folder"} (paste it here): `);
  if (path === null) return false;
  if (!path) { err("No path was entered."); return true; }

  let it;
  try {
    it = await inspect(path, what === "1" ? "file" : "dir");
  } catch (e) {
    err(e.message);
    return true;
  }

  say("");
  say(`Ready: ${B}${it.name}${Z}${it.type === "file" ? "  " + human(it.size) : `  ${D}(folder)${Z}`}`);
  say("  [1] Generate a random pin");
  say("  [2] Use my own pin");
  say("  [b] Back");
  const how = await choice("Choice: ", ["1", "2", "b"]);
  if (how === null) return false;
  if (how === "b") return true;

  let pin = "";
  if (how === "2") {
    const chosen = await ask("Pin/name (anything up to 64 characters, no slashes): ");
    if (chosen === null) return false;
    if (!chosen) { err("No pin was entered."); return true; }
    pin = chosen;
  }

  say("");
  try {
    const up = await send(api, path, pin);
    say(`${G}${B}Uploaded.${Z}`);
    report(up, { copied: opts.copy && copy(up.link) });
  } catch (e) {
    err(e.message);
  }
  return true;
}

async function download(api, opts) {
  banner(api.host);
  say(`${B}Download${Z}`);
  const pin = await ask("Pin to download (or b to go back): ");
  if (pin === null) return false;
  if (!pin || pin.toLowerCase() === "b") return true;

  let hit;
  try {
    hit = await look(api, pin);
  } catch (e) {
    err(e.message);
    return true;
  }
  say("");
  say(`Found: ${B}${hit.name}${Z}  ${human(hit.size)}  ${D}${hit.date}${Z}`);
  say("  [1] Save to this folder");
  say("  [2] Choose a destination folder");
  say("  [b] Back");
  const where = await choice("Choice: ", ["1", "2", "b"]);
  if (where === null) return false;
  if (where === "b") return true;

  let dir = ".";
  if (where === "2") {
    const answer = await ask("Destination folder: ");
    if (answer === null) return false;
    if (!answer) { err("No folder was entered."); return true; }
    dir = answer;
  }

  say("");
  try {
    const got = await receive(api, pin, dir);
    say(`${G}${B}Saved${Z} ${got.path}`);
  } catch (e) {
    err(e.message);
  }
  return true;
}

export async function menu(api, opts) {
  for (;;) {
    const room = await storage(api);
    banner(api.host);
    say("  [1] Upload a file or folder");
    say("  [2] Download with a pin");
    say("  [q] Quit");
    if (room) { say(""); say("  " + room); }

    const pick = await choice("\nChoice: ", ["1", "2", "q"]);
    if (pick === null || pick === "q") { say("Bye."); return; }

    const alive = pick === "1" ? await upload(api, opts) : await download(api, opts);
    if (!alive) { say(""); return; }

    say("");
    const again = await ask(`${D}Enter to go back to the menu, q to quit: ${Z}`);
    if (again === null || again.toLowerCase() === "q") return;   // null is EOF
  }
}
