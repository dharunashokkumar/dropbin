#!/bin/sh
# dropbin — install `db` without npm.
#
# Fetches the release tarball from GitHub, unpacks it into
# ~/.local/share/dropbin and puts a `db` shim on the PATH. Nothing is compiled
# and nothing is built: the package is the same zero-dependency tree npm would
# have installed, so this is the same `db`, fetched a shorter way.
#
# Node 18 or newer has to be there already — `db` is Node, and this script will
# not install one. A machine without Node wants the shell client at /cli
# instead, which needs nothing at all.
#
#   curl -fsSL https://host/install.sh | sh
#   curl -fsSL https://host/install.sh | sh -s -- --version 1.1.0
#   curl -fsSL https://host/install.sh | sh -s -- --uninstall
#
# POSIX sh on purpose: this runs under dash and ash, not just bash.
set -eu

REPO="dharunashokkumar/dropbin"

# Replaced with the request origin when a deployment serves this at
# /install.sh, and left as the literal placeholder when it is fetched from
# GitHub. Testing for "http" rather than for the placeholder is deliberate: the
# substitution replaces *every* occurrence, so a second mention of the
# placeholder here would be rewritten along with the first.
HOST="__HOST__"
case "$HOST" in http*) HOST="${HOST%/}" ;; *) HOST="" ;; esac

VERSION="${DROPBIN_VERSION:-latest}"
DEST="${DROPBIN_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/dropbin}"
BIN="${DROPBIN_BIN:-$HOME/.local/bin}"
TARBALL="${DROPBIN_TARBALL:-}"
ACTION="install"
MARK="dropbin-shim"          # what tells our shim from somebody else's db

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m')
  R=$(printf '\033[31m'); G=$(printf '\033[32m'); Z=$(printf '\033[0m')
else
  B=""; D=""; R=""; G=""; Z=""
fi

say() { printf '%s\n' "$*"; }
die() { printf '%sError:%s %s\n' "$R" "$Z" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
dropbin installer — puts \`db\` on the PATH, without npm.

  --version X.Y.Z   install that release        (default: the latest)
  --dir PATH        where the files go          (default: $DEST)
  --bin PATH        where the shim goes         (default: $BIN)
  --host URL        the deployment \`db\` talks to unless DROP_HOST says otherwise
  --tarball PATH    install a .tgz you already have, instead of downloading one
  --uninstall       remove both again
  -h, --help        this

Same knobs as environment variables: DROPBIN_VERSION, DROPBIN_HOME,
DROPBIN_BIN, DROPBIN_TARBALL, DROP_HOST.
USAGE
  exit 0
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "${2:-}" ] || die "--version needs a release number."; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir) [ "${2:-}" ] || die "--dir needs a path."; DEST="$2"; shift 2 ;;
    --dir=*) DEST="${1#*=}"; shift ;;
    --bin) [ "${2:-}" ] || die "--bin needs a path."; BIN="$2"; shift 2 ;;
    --bin=*) BIN="${1#*=}"; shift ;;
    --host) [ "${2:-}" ] || die "--host needs a URL."; HOST="${2%/}"; shift 2 ;;
    --host=*) HOST="${1#*=}"; HOST="${HOST%/}"; shift ;;
    --tarball) [ "${2:-}" ] || die "--tarball needs a path."; TARBALL="$2"; shift 2 ;;
    --tarball=*) TARBALL="${1#*=}"; shift ;;
    --uninstall|--remove) ACTION="uninstall"; shift ;;
    -h|--help) usage ;;
    *) die "unknown option '$1' — try --help." ;;
  esac
done

VERSION="${VERSION#v}"

# ------------------------------------------------------------- uninstall ---

if [ "$ACTION" = "uninstall" ]; then
  gone=0
  for name in db dropbin; do
    f="$BIN/$name"
    # Only ever remove a shim this script wrote. Somebody else's `db` stays.
    if [ -f "$f" ] && grep -q "$MARK" "$f" 2>/dev/null; then
      rm -f "$f"; say "removed $f"; gone=1
    fi
  done
  if [ -d "$DEST" ] && [ -f "$DEST/bin/db.js" ]; then
    rm -rf "$DEST"; say "removed $DEST"; gone=1
  fi
  [ "$gone" = 1 ] || say "nothing installed here."
  exit 0
fi

# ---------------------------------------------------------------- checks ---

if ! have node; then
  say "${R}Node 18 or newer is required, and there is no node on the PATH.${Z}" >&2
  say "" >&2
  say "  Install Node from https://nodejs.org and run this again — or, for a" >&2
  say "  machine that will never have Node, use the shell client instead:" >&2
  say "" >&2
  say "    ${B}curl -fsSL ${HOST:-https://your-deployment}/cli -o drop && bash drop${Z}" >&2
  exit 1
fi

major=$(node -v 2>/dev/null | sed -e 's/^v//' -e 's/[^0-9].*//')
case "$major" in
  ''|*[!0-9]*) die "cannot read a version out of \`node -v\`." ;;
esac
[ "$major" -ge 18 ] || die "Node 18 or newer is required; this is $(node -v)."

have tar || die "tar is required to unpack the release."
if have curl; then fetch() { curl -fsSL -o "$1" "$2"; }
elif have wget; then fetch() { wget -qO "$1" "$2"; }
elif [ -z "$TARBALL" ]; then die "curl or wget is required to download the release."
fi

# --------------------------------------------------------------- install ---

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/dropbin.tgz"
else
  url="https://github.com/$REPO/releases/download/v$VERSION/dropbin.tgz"
fi

TMP=$(mktemp -d 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/dropbin-install.$$")
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "no such tarball: $TARBALL"
  say "${D}installing $TARBALL${Z}"
  cp "$TARBALL" "$TMP/dropbin.tgz" || die "cannot read $TARBALL."
else
  say "${D}fetching $url${Z}"
  fetch "$TMP/dropbin.tgz" "$url" || die "download failed — is $VERSION a released version?"
fi
tar -xzf "$TMP/dropbin.tgz" -C "$TMP" || die "the tarball did not unpack."
[ -f "$TMP/package/bin/db.js" ] || die "that tarball is not the dropbin package."

# Replace what is there rather than merging into it: a file dropped from one
# release must not survive into the next.
mkdir -p "$(dirname "$DEST")" "$BIN" || die "cannot create $DEST or $BIN."
rm -rf "$DEST"
mv "$TMP/package" "$DEST" || die "cannot move the package into $DEST."

for name in db dropbin; do
  f="$BIN/$name"
  {
    printf '#!/bin/sh\n'
    printf '# %s — written by the dropbin installer. Remove this and %s\n' "$MARK" "$DEST"
    printf '# to uninstall, or re-run install.sh --uninstall.\n'
    # A default the environment still wins over, not a stored setting: `db`
    # itself writes nothing anywhere, and DROP_HOST keeps overriding it.
    if [ -n "$HOST" ]; then
      printf 'DROP_HOST="${DROP_HOST:-%s}"; export DROP_HOST\n' "$HOST"
    fi
    printf 'exec node "%s/bin/db.js" "$@"\n' "$DEST"
  } > "$f" || die "cannot write $f."
  chmod +x "$f"
done

version=$(node "$DEST/bin/db.js" --version 2>/dev/null || printf 'unknown')

say ""
say "  ${G}${B}dropbin $version installed${Z}"
say "    ${D}files${Z}  $DEST"
say "    ${D}db${Z}     $BIN/db"
if [ -n "$HOST" ]; then say "    ${D}host${Z}   $HOST  ${D}(DROP_HOST overrides it)${Z}"; fi
say ""

# An npm install of the same tool leaves a `db` of its own on the PATH, and
# whichever comes first wins. Say so rather than let the wrong one answer.
shadow=""
case ":${PATH:-}:" in
  *":$BIN:"*)
    other=$(command -v db 2>/dev/null || true)
    if [ -n "$other" ] && [ "$other" != "$BIN/db" ]; then shadow="$other"; fi
    ;;
esac
if [ -n "$shadow" ]; then
  say "  ${B}Another db is earlier on your PATH and will answer first:${Z}"
  say "    ${D}$shadow${Z}"
  say "  Remove it (${D}npm rm -g dropbin${Z}) or put $BIN ahead of it."
  say ""
fi

case ":${PATH:-}:" in
  *":$BIN:"*) say "  Run ${B}db${Z} to start." ;;
  *)
    say "  ${B}$BIN is not on your PATH.${Z} Add it:"
    say ""
    case "${SHELL:-}" in
      */fish) say "    ${D}fish_add_path $BIN${Z}" ;;
      */zsh)  say "    ${D}echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && exec zsh${Z}" ;;
      *)      say "    ${D}echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile${Z}" ;;
    esac
    say ""
    say "  Then run ${B}db${Z}."
    ;;
esac
say ""
