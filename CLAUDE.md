# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                      # wrangler dev on 127.0.0.1:8787, R2 simulated on disk
npm run deploy                   # deploy to Cloudflare
npm run logs                     # wrangler tail
npx wrangler deploy --dry-run --outdir /tmp/build   # typecheck-ish: bundles without deploying
npx wrangler secret put ACCESS_PASSWORD             # set the live password
npx wrangler secret list                            # [] means it is still changeme

cd cli && npm pack                                  # build what people install
npm i -g --prefix /tmp/gt cli/dropbin-*.tgz         # try the bin shims safely
cd cli && npm version patch && npm publish          # release `db` to npm
```

There is no test suite. Verification is manual against `npm run dev`: drive the
HTTP surface with `curl`, and the clients with piped input. Every prompt in
every client reads a *line*, so a whole session is one string. `db` is the easy
one to script, because it reads stdin:

```sh
export DROP_PASS=changeme DROP_HOST=http://127.0.0.1:8787
printf '1\n1\n./notes.txt\n2\nmy-pin\nq\n' | node cli/bin/db.js --no-copy
#        │ │ │            │ │      └ q at the "back to the menu" prompt quits
#        │ │ │            │ └ the pin
#        │ │ │            └ 2 = my own pin
#        │ │ └ the path
#        │ └ 1 = file, 2 = folder
#        └ 1 = upload, 2 = download
node cli/bin/db.js < /dev/null      # must print "Bye." and exit, never redraw
```

`src/drop.sh` reads from `/dev/tty` whenever it can open one, so piping drives
it only on a machine without a terminal; test that client by hand instead.

`node --check src/*.js cli/src/*.js` and `bash -n src/drop.sh` catch syntax
errors without a server. For the PowerShell script:
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
`json` from `Accept` (or `?json=1`), so `GET /4821` shows a browser the file
and hands curl the bytes. Do not add separate API paths for this; extend `fmt`
instead.

**A browser looks, everything else downloads.** `GET /PIN` with
`Accept: text/html` is `viewPage()` — the image, video, text or PDF on screen
in the dialog, with a Download button. `?view=1` is the bytes inline (what the
page's `<img>`/`<iframe>` loads), `?dl=1` is the attachment, and anything that
is not a browser still gets the file with no query string at all, which is what
keeps `curl -OJ`, `db get` and both shell clients working. Do not make `/PIN`
download for a browser again: that was the old behaviour and it is the thing
this page exists to fix.

**`viewType()` in `index.js` decides what to call the bytes on the way out**,
and it distrusts the stored type: `db` and `curl -T` both PUT
`application/octet-stream`, and under `nosniff` a vague type means a blank
preview rather than a guess, so the filename wins whenever the stored type says
nothing. Uploads run through it too, so what is stored is right in the first
place.

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

**`db` is the client people install, and `cli/` is its own npm package.**
Published as `dropbin` with two bins (`db` and `dropbin`), plain Node 18+, zero
dependencies, no build step, and invisible to Wrangler — the `[[rules]]` block
below only pulls in the two served scripts. It speaks the same surface as
everything else: `GET /?info=1` doubles as the password check and the storage
read, `PUT /up?quiet=1` with `X-Name`/`X-Pin` uploads, `GET /PIN` downloads,
`DELETE /PIN` reclaims. Change `?info=1` and three clients break, not two.
`cli/src/actions.js` holds the work and both the menu and the flat commands call
it — new behaviour goes there, not into one of them. `db open` and `db qr` do
not use `link()`; they use `share()`, so what they hand over opens without a
password.

**`db` zips folders itself** (`cli/src/zip.js`, `node:zlib`) instead of shelling
out to `zip`/`tar`/`Compress-Archive`, so a fresh machine needs nothing but
Node. Local headers are written with placeholder sizes and patched through the
file handle afterwards rather than using data descriptors, because PowerShell's
`Expand-Archive` is fussy about those; the round trip is verified with both
`unzip -t` and `Expand-Archive`.

**The QR encoder in `cli/src/qr.js` is ours** — byte mode, level M, versions
1-15, no dependency. It was checked module-for-module against the `qrcode` npm
package forced to a single byte segment. That library splits mixed text into
numeric and alphanumeric segments by default, so for a link containing digits
its output differs from ours while both are valid; compare with
`QRCode.create([{ data: link, mode: "byte" }], { errorCorrectionLevel: "M" })`
or the diff is meaningless.

**The two shell CLIs are served, not shipped.** `src/drop.sh` and `src/drop.ps1` are
imported as strings via the `[[rules]]` `type = "Text"` block in
`wrangler.toml`, and `__HOST__` is replaced with the request origin at `/cli`
and `/cli.ps1`. Keep that placeholder intact.

**Auth** (`util.js`): the password arrives as `?p=`, `X-Pass:`, HTTP basic, or
the `dp` cookie. The cookie stores `sha256("dropbin:" + password)`, never the
password, and comparison is length-checked constant time. Only `/cli`,
`/cli.ps1`, `/robots.txt` and `/favicon.ico` skip the gate.

**Share links are the one other way in.** `db open` and `db qr` hand a link to
a browser or a phone, neither of which can be asked for a password, so they
sign one: `?k=<expiry>.<hmac>`, the HMAC keyed on the password over
`"dropbin/" + pin + "/" + exp` (`sign()` in `util.js`, `share()` in
`cli/src/api.js` — **two implementations of one string; change both or
neither**). `/` is the separator because `pinOk()` forbids it, so the three
parts cannot blur into each other. Nothing is stored: `shared()` recomputes it.
A `k` visitor reaches `download()` for that one pin and nothing else — no `/up`,
no `DELETE`, no other pin, no home page — and `shareTtl(env)` caps how far ahead
one may be signed. `db` asks for a week.

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
  `DELETE /PIN`, `drop rm` and `db rm` — deliberately, so storage can be
  reclaimed without putting a destructive key in a menu.
- `db view` prints text and refuses everything else. `show()` in
  `cli/src/actions.js` reads the type off a `HEAD /PIN?view=1` — so the Worker's
  table decides and there is no second copy of it in the client — turns an
  image, a video, a PDF or an archive away *before* fetching a byte of it, and
  points at `db open` and `db get` instead. A file that claims to be text and
  holds a NUL is caught after the fetch. Keep that: the whole point is that a
  binary never reaches the terminal.
- `db` stores nothing. The password is asked for on every run and never written
  anywhere: no config file, no token cache, and `DROP_PASS` covers scripts. Do
  not add a `db login`.
- In `db`, stdout carries the command's *result* — the link, the saved path, the
  storage line, the QR, `--help` — and stderr carries everything else: prompts,
  the progress bar, the pretty summary block after an upload, and errors. So
  `db up x` shows a block and pipes one link, and `db --help | grep qr` works.
- Uploaded files are served with `Content-Security-Policy: sandbox` and
  `nosniff` so an uploaded `.html`/`.svg` cannot act on the origin. Preserve
  those headers on any new file-serving path.

## Traps worth knowing

- **A secret does not override a `[vars]` entry of the same name.** Wrangler
  refuses to create it at all — `Binding name 'ACCESS_PASSWORD' already in use
  [code: 10053]` — so a password listed in `wrangler.toml` is the password,
  and `wrangler secret put` looks like it should fix that but cannot. That is
  why `ACCESS_PASSWORD` is absent from `[vars]` and the `|| "changeme"`
  fallback lives in `util.js` and `index.js` instead. When a client reports a
  correct password rejected, check the deployment before the client:
  `curl -o /dev/null -w '%{http_code}' -H "X-Pass: PASS" https://host/?info=1`
  and `npx wrangler secret list` (an empty `[]` means nothing was ever set).
- **`wrangler secret put` reads stdin when it is not a tty, and an empty value
  is accepted silently** — it prints the same "✨ Success!" and `secret list`
  then shows the name, so everything looks set while `env.ACCESS_PASSWORD` is
  `""`, falsy, and the `|| "changeme"` fallback quietly takes over. Run it as
  `printf 'PASS' | npx wrangler secret put ACCESS_PASSWORD` from any wrapped
  shell, and prove it with the curl above rather than with `secret list`, which
  only ever shows names.
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
- **`db`'s prompts return `null` at end of input, and null means quit.** Same
  trap as above from the other side: Node's readline emits `close` instead of
  failing, so `ask()`, `choice()` and `secret()` in `cli/src/term.js` resolve to
  null and every caller has to return on it. Reach for `?.` on one of those
  answers and EOF silently becomes "keep going", which redraws the menu forever.
- In Git Bash, an argument that looks like a Unix path (`-d 'next=/demo'`) is
  rewritten to `C:/Program Files/Git/demo`. Prefix such commands with
  `MSYS_NO_PATHCONV=1` when testing.
- In Git Bash on Windows, `db up $(pwd)/x` hands Node `/c/Users/…`, which
  `path.resolve` maps onto the current drive root instead. `expand()` in
  `cli/src/actions.js` rewrites a leading `/c/` to `c:/` for that reason.
- **`Content-Security-Policy: sandbox` and Chrome's PDF viewer do not mix.** The
  preview `<iframe>` shows a PDF in Firefox (pdf.js is ordinary JS in the page)
  and a blank box in headless Chrome, which treats its viewer as a plugin the
  sandbox blocks. Images, video, audio and text are fine everywhere. The header
  stays — it is what stops an uploaded `.html`/`.svg` acting on the origin — so
  every preview keeps a Download and a "Full window" button under it. Do not
  weaken the CSP to make one file type render.
- Chrome can be driven headless for a look at the UI without the browser
  extension:
  `chrome --headless=new --disable-gpu --virtual-time-budget=5000
  --user-data-dir=SOMEWHERE --window-size=760,620 --screenshot=out.png URL`.

## Keeping this file honest

Change anything in this tool — routes, the two-option shape, the `?info=1`
format, limits — and update this file and `README.md` in the same pass. The
user asked for this explicitly; a stale CLAUDE.md is worse than none.
