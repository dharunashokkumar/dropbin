// Argument handling, the password gate, and the flat commands.
//
// The password is asked for on every run and never written anywhere: there is
// no config file and no token cache. DROP_PASS exists for scripts, DROP_HOST
// for anyone running their own deployment.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Api, DEFAULT_HOST } from "./api.js";
import { look, receive, report, send, show } from "./actions.js";
import { menu } from "./menu.js";
import { browse, copy } from "./sys.js";
import { ask, err, human, out, release, say, secret, B, D, G, Z } from "./term.js";
import { render } from "./qr.js";

const HELP = `dropbin — send a file, get a file, nothing else.

  db                       the menu
  db up PATH [PIN]         upload a file, or a folder zipped first
  db get PIN [FOLDER]      download what a pin holds (never overwrites)
  db view PIN              print a pin to the terminal, if it is text
  db qr PIN                a scannable code that opens without the password
  db open PIN              look at it in a browser, no password asked
  db rm PIN                delete a pin and get the space back
  db free                  how much room is left

  --host URL               a different deployment, just for this command
  --no-copy                do not put the link on the clipboard
  -h, --help               this
  -v, --version            the version

  DROP_HOST                default deployment (${DEFAULT_HOST})
  DROP_PASS                skip the password prompt, for scripts and CI

The password is asked for every run and stored nowhere.`;

const ALIAS = {
  up: "up", put: "up", upload: "up", push: "up",
  get: "get", dl: "get", download: "get", pull: "get",
  view: "view", cat: "view",
  rm: "rm", del: "rm", delete: "rm",
  free: "free", df: "free", space: "free", usage: "free",
  qr: "qr", open: "open",
  help: "help", version: "version",
};

function version() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function parse(argv) {
  const opts = { host: process.env.DROP_HOST || DEFAULT_HOST, copy: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") {
      if (!argv[i + 1]) { err("--host needs a URL."); process.exit(2); }
      opts.host = argv[++i];
      continue;
    }
    if (a.startsWith("--host=")) { opts.host = a.slice(7); continue; }
    if (a === "--no-copy") { opts.copy = false; continue; }
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "-v" || a === "-V" || a === "--version") { opts.version = true; continue; }
    rest.push(a);
  }
  if (!/^https?:\/\//i.test(opts.host)) opts.host = "https://" + opts.host;
  opts.host = opts.host.replace(/\/+$/, "");
  return { opts, rest };
}

/** The gate: a password every run, checked against ?info=1 before anything else. */
async function connect(host) {
  let pass = process.env.DROP_PASS || "";
  const asked = !pass;
  for (let tries = 0; tries < 3; tries++) {
    if (!pass) {
      const typed = await secret(`Password for ${host.replace(/^https?:\/\//, "")}: `);
      if (!typed) { err("A password is required."); process.exit(1); }
      pass = typed;
    }
    const api = new Api(host, pass);
    let r;
    try {
      r = await api.info();
    } catch (e) {
      err(`cannot reach ${host}: ${e.message}`);
      process.exit(1);
    }
    if (r.ok) return { api, info: r };
    if (r.status !== 401) {
      err(`${host} answered HTTP ${r.status}${r.body ? " — " + r.body.split("\n")[0] : ""}`);
      process.exit(1);
    }
    if (!asked) { err("DROP_PASS was not accepted."); process.exit(1); }
    err("That password was not accepted.");
    pass = "";
  }
  process.exit(1);
}

/* -------------------------------------------------------------- commands --- */

async function cmdUp(api, opts, args) {
  let path = args[0];
  if (!path) {
    const typed = await ask("Path to the file or folder: ");
    if (!typed) { err("No path was given."); return 2; }
    path = typed;
  }
  const up = await send(api, path, args[1] || "");
  say(`${G}${B}Uploaded.${Z}`);
  report(up, { copied: opts.copy && copy(up.link) });
  out(up.link);                                   // the one line a script wants
  return 0;
}

async function cmdGet(api, opts, args) {
  if (!args[0]) { err("Which pin?"); return 2; }
  const got = await receive(api, args[0], args[1] || ".");
  say(`${G}${B}Saved${Z} ${got.name}  ${human(got.size)}`);
  out(got.path);
  return 0;
}

async function cmdView(api, opts, args) {
  if (!args[0]) { err("Which pin?"); return 2; }
  // Anything a terminal cannot show throws instead, and says where to go.
  const seen = await show(api, args[0]);
  out(seen.text);
  return 0;
}

async function cmdRm(api, opts, args) {
  if (!args[0]) { err("Which pin?"); return 2; }
  const r = await api.remove(args[0]);
  if (!r.ok) { err(r.body || `HTTP ${r.status}`); return 1; }
  out(`${G}${r.body}${Z}`);
  return 0;
}

async function cmdFree(api, opts, args, info) {
  const r = info || (await api.info());
  if (!r.ok) { err(`HTTP ${r.status}`); return 1; }
  const free = Math.max(0, r.quota - r.used);
  out(`${human(r.used)} used · ${B}${human(free)} free${Z} of ${human(r.quota)} · ` +
    `${r.pins} pin${r.pins === 1 ? "" : "s"}`);
  return 0;
}

// These two hand the link to something that cannot be asked for a password — a
// browser, or a phone pointed at a code — so both share it instead of linking
// it: one pin, read-only, a week, and the far end lands on the preview page.
const SHARED = "no password, for the next 7 days";

async function cmdQr(api, opts, args) {
  if (!args[0]) { err("Which pin?"); return 2; }
  const hit = await look(api, args[0]);
  const link = api.share(args[0]);
  out("");
  out(render(link, { colour: !!process.stdout.isTTY && !process.env.NO_COLOR }));
  out("");
  out(`  ${hit.name}  ${human(hit.size)}`);
  out(`  ${D}${link}${Z}`);
  say(`${D}Scanning it shows the file in a browser — ${SHARED}.${Z}`);
  return 0;
}

async function cmdOpen(api, opts, args) {
  if (!args[0]) { err("Which pin?"); return 2; }
  const hit = await look(api, args[0]);
  const link = api.share(args[0]);
  browse(link);
  say(`Opening ${B}${hit.name}${Z}  ${human(hit.size)}  ${D}(${SHARED})${Z}`);
  out(link);
  return 0;
}

/* ---------------------------------------------------------------- entry --- */

export async function main(argv) {
  const { opts, rest } = parse(argv);
  if (opts.help) { out(HELP); return; }
  if (opts.version) { out(version()); return; }

  const word = rest[0] ? ALIAS[rest[0].toLowerCase()] : null;
  if (rest[0] && !word) {
    err(`unknown command '${rest[0]}'`);
    say(HELP);
    process.exit(2);
  }
  if (word === "help") { out(HELP); return; }
  if (word === "version") { out(version()); return; }

  const { api, info } = await connect(opts.host);
  const args = rest.slice(1);
  let code = 0;
  try {
    switch (word) {
      case "up": code = await cmdUp(api, opts, args); break;
      case "get": code = await cmdGet(api, opts, args); break;
      case "view": code = await cmdView(api, opts, args); break;
      case "rm": code = await cmdRm(api, opts, args); break;
      case "free": code = await cmdFree(api, opts, args, info); break;
      case "qr": code = await cmdQr(api, opts, args); break;
      case "open": code = await cmdOpen(api, opts, args); break;
      default: await menu(api, opts);
    }
  } catch (e) {
    err(e.message);
    code = 1;
  }
  release();
  if (code) process.exit(code);
}
