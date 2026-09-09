# dropbin

[![CI](https://github.com/dharunashokkumar/dropbin/actions/workflows/ci.yml/badge.svg)](https://github.com/dharunashokkumar/dropbin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dropbin)](https://www.npmjs.com/package/dropbin)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Instant file sharing on one Cloudflare Worker + one R2 bucket.

There are two things you can do — **upload** and **download** — and the whole
tool is built around only those two. Uploading gets you a **PIN**; anyone with
the PIN *and* the password can take the thing back out, in a browser or in a
terminal. Nothing lists what is stored, anywhere. The only number either front
end reports is how much room is left.

**A pin holds exactly one thing.** Upload a file and the pin holds that file.
Upload a folder and it is zipped on your machine first, so the pin holds one
zip — and downloading gives you that zip straight back.

```
 dropbin  files.example.com
 ----------------------------------------------------------------------
   1  upload     a file or a folder
   2  download   with a pin
 ----------------------------------------------------------------------
 [#.....................]  9.71 GB free of 10.0 GB   6 pin(s) stored
 1 or 2 to choose, q to quit
```

## Deploy

```sh
npm install
npx wrangler login                       # opens a browser, once
npx wrangler r2 bucket create dropbin    # needs R2 enabled on the account
npx wrangler deploy
```

That prints a `https://dropbin.<you>.workers.dev` URL, which already works.

For your own domain, set `[[routes]]` in `wrangler.toml` and deploy again:

```toml
[[routes]]
pattern = "files.example.com"
custom_domain = true
```

The zone has to be on the same Cloudflare account; Wrangler makes the DNS
record itself.

### The password

`changeme` until you set one — that fallback is in the code, not in
`wrangler.toml`, which deliberately keeps `ACCESS_PASSWORD` out of `[vars]`:

```sh
npx wrangler secret put ACCESS_PASSWORD    # takes effect at once, no redeploy
```

A secret does **not** override a var of the same name; Wrangler refuses to
create one, with `Binding name 'ACCESS_PASSWORD' already in use`. So if you have
added the var back, remove it and `npx wrangler deploy` before setting the
secret. Check what is live with `npx wrangler secret list` — an empty `[]` means
the password is still `changeme`, whatever you think you set.

Changing it invalidates the `dp` cookie in every browser and every outstanding
`db open` / `db qr` link, since those are signed with the password as the key.

It gates everything except `/cli`, `/cli.ps1`, `/robots.txt` and the favicon.
Accepted four ways: `?p=`, an `X-Pass:` header, HTTP basic auth, or the `dp`
cookie the web login sets (one year).

### The storage meter

`QUOTA_GB` in `wrangler.toml` is what the meter counts down from — 10 GB, to
match R2's free tier. It is a display figure, not an enforced cap; R2 will keep
accepting uploads past it and start billing.

## The `db` command

Anyone who uses this more than once should install the tool. One command, then
`db` is on the path:

```sh
npm i -g dropbin        # installs `db`, and `dropbin` as a longer alias
db                      # the menu
```

A zero-dependency Node package (18 or newer) that lives in [`cli/`](cli) and is
published from there. The Worker only advertises it; nothing about the tool runs
on the server.

```sh
db up ./holiday.png            # a file, random pin
db up ./holiday.png photos     # a file, your own pin
db up ./project                # a folder — zipped here, then sent
db get 4821                    # save it in this folder
db get 4821 ~/Downloads        # save it there
db view 4821                   # print it here, if it is text
db qr 4821                     # a code to point a phone at
db open 4821                   # look at it in a browser
db rm 4821                     # throw the pin away
db free                        # how much room is left
```

The menu offers the same two options the shell client does, and nothing else:

```
 dropbin  files.example.com
 --------------------------------------------------------------
   [1] Upload a file or folder
   [2] Download with a pin
   [q] Quit

   Storage: 9.71 GB free of 10.00 GB · 6 pins stored

 Choice:
```

The password is asked for on every run and stored nowhere — there is no config
file and no token cache. `DROP_PASS=...` skips the prompt for scripts and CI,
`DROP_HOST=...` (or `--host`) points `db` at another deployment. After an upload
the link goes to the clipboard unless you pass `--no-copy`. Folders are zipped
with `node:zlib`, so `zip`, `tar` and `Compress-Archive` do not have to exist.
Downloads never overwrite: a second copy of `holiday.png` becomes
`holiday.png.1`. `db up` and `db get` print the one useful line — the link, the
saved path — on stdout and everything else on stderr, so they pipe cleanly.

## The client with nothing to install

For a one-off, or a machine without Node: the Worker hands you a shell script,
already pointed at your host.

```sh
curl -s https://files.example.com/cli -o drop && bash drop
bash <(curl -s https://files.example.com/cli)     # or in one line
```

It asks for the password, then shows the two options. Press `1` or `2`; `q`
goes back, and `q` at the top quits.

**Upload** asks three things and nothing else:

```
 Upload

   1  file
   2  folder   (zipped before it is sent)
   q  back

  file to upload: ./holiday.png

   1  random pin   (4 digits)
   2  custom pin   (anything you like)

 Uploaded

   pin    4821
   file   [IMG] holiday.png   2.41 MB
   url    https://files.example.com/4821
```

**Download** asks for a pin, tells you what is behind it, and lets you take it
or read it:

```
 Download   pin 4821

   [IMG] holiday.png   2.41 MB   2026-09-08 11:39

   1  download   into the current directory
   2  view       in the pager
   q  back
```

A folder is packed with `zip` if it is installed and `tar -czf` otherwise, so
the pin holds a `.zip` or a `.tgz`. Downloads land in the directory you started
from and never overwrite: a second copy becomes `name.1`. `DROP_PASS=…` skips
the password prompt, `DROP_HOST=…` points it at a different deployment.

On Windows PowerShell the same client is at `/cli.ps1` (folders go through
`Compress-Archive`):

```powershell
irm https://files.example.com/cli.ps1 -OutFile drop.ps1 ; ./drop.ps1
```

### Or as plain commands

Give it arguments and it skips the menu entirely:

```sh
./drop up ./holiday.png          # a file, random pin
./drop up ./holiday.png photos   # a file, your pin
./drop up ./project              # a folder — zipped, then sent
./drop get 4821                  # save it here
./drop get 4821 ~/Downloads      # save it there
./drop view 4821                 # print it
./drop rm 4821                   # throw the pin away
./drop free                      # how much room is left
```

### Or just curl

```sh
export PASS=changeme
curl -T ./holiday.png "https://:$PASS@files.example.com/up/"   # upload
curl -OJ "https://files.example.com/4821?p=$PASS"              # download
curl "https://files.example.com/4821?info=1&p=$PASS"           # what is it?
curl -X DELETE "https://files.example.com/4821?p=$PASS"        # throw it away
curl "https://files.example.com/?p=$PASS"                      # room left
```

> `curl -T` only appends the local filename when the URL ends in `/` **and**
> has no query string — hence the `https://:$PASS@host/up/` form, which sends
> the password as basic auth instead. `-H "X-Pin: photos"` picks the pin and
> `-H "X-Name: other.png"` picks the stored name. In PowerShell write
> `curl.exe`; bare `curl` is an alias for `Invoke-WebRequest`.

## The web page

Open the domain, type the password once, and you get a grey dialog with two
buttons and a storage meter — Upload and Download, and nothing else to click.

**Upload** asks the same three things as the terminal: file or folder, then a
random 4-digit pin or one you type, then it sends and shows you the pin.
**Download** is a pin box; type one and you get the file's name, size and date
with `Download`, `View` and `Close`.

It works with JavaScript off, except for folders: a folder is zipped in the
browser (STORE, no compression) so the Worker never spends CPU on it, and that
needs JS. With JS off the folder option is greyed out and single files still
upload through a plain form post.

## API

| method | path | what |
|---|---|---|
| GET | `/` | the two options and the meter — `?info=1` `?json=1` |
| GET | `/PIN` | a browser looks at it, everything else downloads it |
| GET | `/PIN?view=1` | the bytes inline; `?dl=1` saves them; ranges supported |
| GET | `/PIN?info=1` | what the pin holds, without fetching it |
| GET | `/PIN?k=EXP.SIG` | a share link: that one pin, read-only, no password |
| PUT | `/up` | raw-body upload — `X-Name`, `X-Pin`, `?quiet=1` |
| POST | `/up` | multipart: one file field + optional `pin` |
| DELETE | `/PIN` | throw the pin away |
| GET | `/cli`, `/cli.ps1` | the client scripts, pre-pointed at this host |
| GET | `/upload`, `/get` | the browser's two dialogs |

`?info=1` is the terminal client's only data feed, one tab-separated line:

- `/?info=1` → `pins` `used` `quota`, all in bytes
- `/PIN?info=1` → `name` `size` `date`

### Share links

`db open` and `db qr` hand a link to something that cannot be asked for a
password — a browser, or a phone pointed at a code — so they sign one instead
of just linking it. `?k=` is an expiry and an HMAC of the pin, keyed on the
password: nothing is stored anywhere, it opens exactly that one pin, it is
read-only (a `DELETE` or an upload with it is refused), and it lasts a week.
`SHARE_HOURS` in `wrangler.toml` caps how far ahead one may be signed.

A browser landing on a pin gets the file on screen — an image, a video, text,
a PDF — with a Download button it has to be asked for. Uploaded files still
carry `Content-Security-Policy: sandbox` and `nosniff`, so an uploaded page
cannot act on the origin while it is being looked at.

## Notes

- A pin is 4 digits by default — 9000 of them, checked for collisions before
  one is handed out, and widened to 6 digits if they ever all fill up. A custom
  pin is anything up to 64 characters that is not a slash, a control character
  or a reserved word (`up`, `cli`, `get`, `upload`, `api`, …).
- **Uploading to a pin you have already used replaces what was there.** One
  pin, one thing.
- Files live until you delete them — there is no expiry job.
- Everything here fits the free plans: Workers Free (100k requests/day) and R2
  Free (10 GB, 1M class-A + 10M class-B ops a month).
- Free-plan Workers cap a request body at 100 MB, so that is the per-upload
  ceiling. Uploads, downloads and the meter are pure I/O, with no CPU ceiling —
  which is exactly why folders are zipped by the client and never by the
  Worker.
- Uploaded files are served with `Content-Security-Policy: sandbox` and
  `nosniff`, so an uploaded `.html` or `.svg` cannot act on this origin.
- Pins written by older versions held several files. Those still work: they
  come back out as one zip, capped at `ZIP_LIMIT_MB` of hashing, and the
  individual files stay reachable at `/PIN/path/to/file`.
- Local dev: `npm run dev`. R2 is simulated on disk; nothing touches the cloud.
- The `db` tool is a second npm package in `cli/`, published as `dropbin`. It
  is not bundled into the Worker — only `src/drop.sh` and `src/drop.ps1` are.
- **Change anything in this tool and update `CLAUDE.md` (and this README) to match.**

## Working on it

Read [`CLAUDE.md`](CLAUDE.md) first — it is the architecture, and it explains
why most of the obvious features are deliberately absent, what CI checks, and
how to verify a change against `npm run dev` (there is no test suite). Deploys
and npm releases are run by hand, not by a workflow.

Found a security problem? Do not open an issue —
[report it privately](https://github.com/dharunashokkumar/dropbin/security/advisories/new).
[`SECURITY.md`](SECURITY.md) also covers the threat model and how to harden a
deployment: set a real password, prefer `X-Pass:` over `?p=`, and put a rate
limit in front of it.

## License

[MIT](LICENSE) © Dharun Ashokkumar
