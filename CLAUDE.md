# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                      # wrangler dev on 127.0.0.1:8787, R2 simulated on disk
npm run deploy                   # deploy to Cloudflare
npm run logs                     # wrangler tail
npx wrangler deploy --dry-run --outdir /tmp/build   # typecheck-ish: bundles without deploying
npx wrangler secret put ACCESS_PASSWORD             # override the password var
```

There is no test suite. Verification is manual against `npm run dev`: drive the
HTTP surface with `curl` and the two clients with piped keystrokes. The menu
reads one keypress at a time and text prompts read a line, so a whole session
is one string — this uploads a file under a custom pin and quits:

```sh
export DROP_PASS=changeme DROP_HOST=http://127.0.0.1:8787
printf '12./proj\n2my pin\nx' | bash <(curl -s localhost:8787/cli)
#        ││       │ │       └ any key dismisses the confirmation, then EOF quits
#        ││       │ └ the pin
#        ││       └ 2 = custom pin
#        │└ the path
#        └ 1 = upload, 2 = folder
```

`node --check src/*.js` and `bash -n src/drop.sh` catch syntax errors without a
server. For the PowerShell script:
`[System.Management.Automation.Language.Parser]::ParseFile(path,[ref]$null,[ref]$e)`.

Stopping `wrangler dev` leaves `workerd.exe` and a `node ... wrangler.js dev`
process alive on Windows; they keep `.wrangler/state` locked. Kill both before
deleting that directory.

## Architecture

One Worker (`src/index.js`) over one R2 bucket. No framework, no runtime
dependencies, and no build step beyond Wrangler's bundler.

**There are two operations, and the whole design follows from that.** Upload
and download. No listing exists anywhere — not in the UI, not in the CLI, not
as an endpoint. The only aggregate the tool will report is `usage()`: bytes
used and how many pins exist. Do not add a browse, search or index path.

**A pin holds exactly one object.** The R2 key is `PIN/name`, so resolving a
pin is one `list({ prefix: pin + "/" })` and `pinFind()` collapses the result to
one downloadable thing. A folder is zipped *by the client* before it is sent,
so it arrives as one object like everything else. Uploading to a pin that
already exists deletes what was there first — that invariant is what lets every
other path stay this short.

**Folders are never zipped by the Worker.** The browser builds the zip in
`ui.js`'s `JS` blob and the shell/PowerShell clients shell out to
`zip`/`tar`/`Compress-Archive`. This is deliberate: CRC32 in JS costs ~1.4 ms
per MB and a free-plan Worker gets 10 ms of CPU per request, so a server-side
zip breaks somewhere north of 7 MB. `zipStream()` in `util.js` survives only for
the legacy path below. Keep per-byte work out of the Worker.

**One route serves three audiences.** `fmt(req, url)` picks `html` / `text` /
`json` from `Accept` (or `?json=1`), so `GET /4821` returns the file to a
browser and `GET /?info=1` returns a tab-separated line to curl. Do not add
separate API paths for this; extend `fmt` instead.

**`?info=1` is the clients' only data feed** — one tab-separated line,
`pins/used/quota` at the root and `name/size/date` on a pin. Both clients parse
it, so changing that format breaks them at once.

**Resolution order** in `route()`: `/up`, `/api/*`, `/cli*`, `/upload` and
`/get` are claimed first (all of them are in `RESERVED`), a single segment is a
pin, and a deeper path only resolves if a real object sits there. `new URL()`
has already collapsed `..` before any of this runs.

**Pins.** Random ones are 4 digits, collision-checked, widening to 6 if all
9000 fill. Custom ones are anything up to 64 characters that is not a slash, a
control character or reserved — `pinOk()` is deliberately permissive, so every
link is built with `encodeURIComponent`.

**The two CLIs are served, not shipped.** `src/drop.sh` and `src/drop.ps1` are
imported as strings via the `[[rules]]` `type = "Text"` block in
`wrangler.toml`, and `__HOST__` is replaced with the request origin at `/cli`
and `/cli.ps1`. Keep that placeholder intact.

**Auth** (`util.js`): the password arrives as `?p=`, `X-Pass:`, HTTP basic, or
the `dp` cookie. The cookie stores `sha256("dropbin:" + password)`, never the
password, and comparison is length-checked constant time. Only `/cli`,
`/cli.ps1`, `/robots.txt` and `/favicon.ico` skip the gate.

**Legacy pins.** Versions before this one wrote several objects under one pin.
`pinFind()` still detects that and hands them back as a single zip through
`zipStream()` (capped by `zipLimit(env)`, a CPU budget), and `/PIN/sub/file`
still resolves. Nothing written today produces such a pin.

## Conventions

- The web UI is a desktop file-manager dialog, not a web page: grey `#c0c0c0`
  face, `box-shadow` bevels, navy title bar with a close box, `[IMG]`/`[TXT]`
  markers. It commits to that one look — there is no dark-mode variant, and
  that is on purpose.
- Keep it server-rendered. JavaScript adds exactly two things: the client-side
  folder zip and the progress readout. Single-file upload and every download
  must keep working with JS off, which is why the folder `<input>` ships
  `disabled hidden` and is enabled by `ready()`.
- The interactive clients offer two options and no more. Delete exists only as
  `DELETE /PIN` and `drop rm` — deliberately, so storage can be reclaimed
  without putting a destructive key in a menu.
- Uploaded files are served with `Content-Security-Policy: sandbox` and
  `nosniff` so an uploaded `.html`/`.svg` cannot act on the origin. Preserve
  those headers on any new file-serving path.

## Traps worth knowing

- **`wrangler dev` serves `/cli` pointed at the custom-domain route**, not at
  localhost: `url.origin` is `http://files.dharun.dev` even when you fetched
  from `127.0.0.1:8787`, so a locally downloaded `drop` talks to *production*.
  Always `export DROP_HOST=http://127.0.0.1:8787` when testing the clients.
- `curl -T` appends the local filename only when the URL ends in `/` **and**
  has no query string. Hence the documented `https://:$PASS@host/up/` form
  (basic auth, no query) and the `X-Name` / `X-Pin` headers.
- In awk, `s=s(x)` parses as a *function call*, not concatenation — the space in
  `s = s (…)` inside `bar()` in `drop.sh` is load-bearing.
- **A menu built on a line-reader spins forever once stdin runs dry.** Both
  bash's `read` and PowerShell's `Read-Host` return an *empty string* at end of
  input rather than failing, so the loop redraws and re-prompts at full speed
  and floods the terminal. `key()` in `drop.sh` returns `q` when `read` fails,
  `ask_pass` exits on an empty answer, and `drop.ps1` reads through
  `[Console]::In.ReadLine()` (which does return `$null` at EOF) whenever input
  is redirected. Keep every new prompt on those helpers; test with
  `-RedirectStandardInput` pointed at an empty file, or `< /dev/null`.
- PowerShell unrolls a one-element array when an `if` expression's value is
  assigned, so `$a = if (…) { @($x[1..1]) }` yields a bare string and `$a[0]`
  then returns a single character. Assign inside the branches instead.
- In Git Bash, an argument that looks like a Unix path (`-d 'next=/demo'`) is
  rewritten to `C:/Program Files/Git/demo`. Prefix such commands with
  `MSYS_NO_PATHCONV=1` when testing.

## Keeping this file honest

Change anything in this tool — routes, the two-option shape, the `?info=1`
format, limits — and update this file and `README.md` in the same pass. The
user asked for this explicitly; a stale CLAUDE.md is worse than none.
