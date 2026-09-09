# dropbin

`db` — send a file, get a link. Give someone the pin, they get the file back.
That is the whole tool.

It talks to a [dropbin](https://github.com/dharunashokkumar/dropbin) deployment:
one Cloudflare Worker over one R2 bucket. You need its host and its password.

## Install

```sh
npm i -g dropbin
```

That installs `db` (and `dropbin`, the same program under a longer name). Node
18 or newer, no dependencies, nothing to configure.

## Use

```sh
db                             # the menu: upload or download
db up ./holiday.png            # a file, random pin
db up ./holiday.png photos     # a file, your own pin
db up ./project                # a folder — zipped here, then sent
db get 4821                    # save it in this folder
db get 4821 ~/Downloads        # save it there
db view 4821                   # print a text file
db qr 4821                     # a code to point a phone at
db open 4821                   # open the link in a browser
db rm 4821                     # throw the pin away
db free                        # how much room is left
```

A pin holds exactly one thing, so uploading to a pin you have already used
replaces what was there. Downloads never overwrite: a second copy of
`holiday.png` lands as `holiday.png.1`.

The link is copied to your clipboard after an upload. `--no-copy` turns that
off.

## The password

You are asked for it on every run, and it is stored nowhere — no config file,
no token cache. For scripts and CI, put it in the environment instead:

```sh
DROP_PASS=… db up ./build.zip nightly
```

`db up` and `db get` print the one useful line (the link, the saved path) on
stdout and everything else on stderr, so they pipe cleanly.

## A different deployment

`db` points at `https://files.dharun.dev` unless you say otherwise:

```sh
DROP_HOST=https://files.example.com db free
db --host files.example.com free          # just this once
```

## Folders

Zipped before they are sent, with `node:zlib` — `zip`, `tar` and
`Compress-Archive` do not have to be installed. The server never zips
anything: a Worker gets 10 ms of CPU per request, and hashing alone costs about
1.4 ms per megabyte.

## What it will not do

List anything. There is no index, no search and no browse — not in this tool,
not in the web page, not in the API. If you lose a pin, the thing behind it is
gone as far as you are concerned. That is the deal the whole design is built
on.
