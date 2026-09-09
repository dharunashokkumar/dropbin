# Contributing

Thanks for looking. This is a small tool with a deliberately small surface, so
the most useful thing you can read before writing any code is
[`CLAUDE.md`](CLAUDE.md) — it is the architecture document, and it explains
*why* most of the obvious features are missing.

## The shape of the thing

**There are two operations: upload and download.** Everything follows from
that. Before opening a PR, check it against these, because a change that
breaks one of them will be turned down however well it is written:

- **No listing, anywhere.** Not in the UI, not in a client, not as an
  endpoint. The only aggregate the tool reports is `usage()` — bytes used and
  how many pins exist. No browse, no search, no index.
- **A pin holds exactly one object.** The R2 key is `PIN/name`. A folder is
  zipped *by the client* before it is sent, so it arrives as one object like
  everything else. Uploading to an existing pin replaces what was there.
- **No per-byte work in the Worker.** CRC32 costs ~1.4 ms per MB and a
  free-plan Worker gets 10 ms of CPU per request. Zipping, hashing and
  transcoding belong on the client.
- **One route serves three audiences.** `fmt(req, url)` picks `html` / `text` /
  `json` from `Accept` (or `?json=1`). Extend `fmt`; do not add a parallel
  `/api/...` path for something `/PIN` already does.
- **`?info=1` is a contract.** One tab-separated line — `pins/used/quota` at
  the root, `name/size/date` on a pin. Three clients parse it (`cli/src/api.js`,
  `src/drop.sh`, `src/drop.ps1`). Change the format and you change all of them
  in the same PR.
- **The interactive clients offer two options and no more.** Delete exists as
  `DELETE /PIN`, `drop rm` and `db rm` only — deliberately, so nothing
  destructive sits in a menu.
- **`db` stores nothing.** The password is asked for every run: no config file,
  no token cache, no `db login`. `DROP_PASS` covers scripts.
- **The web UI is a desktop file-manager dialog.** Grey `#c0c0c0`, bevels, a
  navy title bar. It commits to that one look; there is no dark mode, on
  purpose. Single-file upload and every download must keep working with
  JavaScript off.

New behaviour in `db` goes into `cli/src/actions.js`, which the menu and the
flat commands both call — not into one of them.

## Getting set up

```sh
npm install
npm run dev            # wrangler dev on 127.0.0.1:8787, R2 simulated on disk
```

`wrangler dev` needs no Cloudflare account. Deploying does.

**Always `export DROP_HOST=http://127.0.0.1:8787` when testing a client.**
`wrangler dev` serves `/cli` pointed at the *custom domain* in `wrangler.toml`,
so a locally downloaded `drop` otherwise talks to production.

## Verifying a change

There is no test suite yet (see the open issue — patches welcome). Verification
is manual, and these are the checks CI also runs:

```sh
node --check src/*.js cli/src/*.js       # every JS file parses
bash -n src/drop.sh                      # the bash client parses
pwsh -c '[System.Management.Automation.Language.Parser]::ParseFile("src/drop.ps1",[ref]$null,[ref]$e)'
npx wrangler deploy --dry-run --outdir dist    # bundles without deploying
```

Then drive the HTTP surface with `curl` and the clients with piped input. Every
prompt in every client reads a *line*, so a whole session is one string:

```sh
export DROP_PASS=changeme DROP_HOST=http://127.0.0.1:8787
printf '1\n1\n./notes.txt\n2\nmy-pin\nq\n' | node cli/bin/db.js --no-copy
#        │ │ │            │ │      └ q at the "back to the menu" prompt quits
#        │ │ │            │ └ the pin
#        │ │ │            └ 2 = my own pin
#        │ │ └ the path
#        │ └ 1 = file, 2 = folder
#        └ 1 = upload, 2 = download
```

`src/drop.sh` reads from `/dev/tty` whenever it can open one, so piping only
drives it on a machine without a terminal — test that client by hand.

**A menu built on a line-reader spins forever once stdin runs dry.** Bash's
`read` and PowerShell's `Read-Host` both return an empty string at EOF, and
Node's readline emits `close` rather than failing. Every prompt must go through
the helper that turns EOF into a quit — `key()` in `drop.sh`, `[Console]::In.ReadLine()`
in `drop.ps1`, `ask()`/`choice()`/`secret()` in `cli/src/term.js`, whose `null`
means quit. Reach for `?.` on one of those answers and EOF silently becomes
"keep going". Test any new prompt with `< /dev/null` (or `-RedirectStandardInput`
pointed at an empty file) and watch that it exits instead of redrawing.

Other traps that have bitten before are listed under **Traps worth knowing** in
`CLAUDE.md`. Read them; they are all real.

## Line endings

`src/drop.sh` and `src/drop.ps1` are served verbatim by the Worker and
`cli/bin/db.js` ships to npm with a shebang, so those files must keep LF
endings on every checkout. `.gitattributes` enforces it and CI fails on a CR.
Do not "fix" it in your editor.

Keep the `__HOST__` placeholder in both shell clients — `/cli` and `/cli.ps1`
replace it with the request origin at serve time. CI checks it is still there.

## Pull requests

- One change per PR, and say what you verified and how.
- **Change anything in the tool — routes, the two-option shape, the `?info=1`
  format, limits — and update `CLAUDE.md` and `README.md` in the same pass.** A
  stale `CLAUDE.md` is worse than none. This is the one rule the repo is
  strictest about.
- Match the surrounding code: no framework, no runtime dependencies, no build
  step beyond Wrangler's bundler, and no new npm dependency in `cli/` (the
  package is zero-dependency, Node 18+, and that is a feature).
- Comments in this codebase explain *why*, not *what*. Keep that.
- Bump `cli/package.json` only when you intend a release; publishing is a
  separate step (`.github/workflows/publish.yml`, on a `v*` tag).

## Reporting things

- Bugs and ideas: [open an issue](https://github.com/dharunashokkumar/dropbin/issues/new/choose).
- Security problems: **do not** open an issue — see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your work is licensed under the
[MIT License](LICENSE) that covers this project.
