# dropbin — install `db` without npm.
#
#   irm __HOST__/install.ps1 | iex
#
# Fetches the release zip from GitHub, unpacks it under
# %LOCALAPPDATA%\dropbin\app and puts a `db` shim in %LOCALAPPDATA%\dropbin\bin,
# which it adds to your user PATH. Nothing is compiled and nothing is built: the
# package is the same zero-dependency tree npm would have installed, so this is
# the same `db`, fetched a shorter way.
#
# Node 18 or newer has to be there already — `db` is Node, and this script will
# not install one. A machine without Node wants the client at /cli.ps1 instead,
# which needs nothing at all.
#
# `iex` cannot pass arguments, so for anything but a plain install run it as a
# script block:
#
#   & ([scriptblock]::Create((irm __HOST__/install.ps1))) -Version 1.1.0
#   & ([scriptblock]::Create((irm __HOST__/install.ps1))) -Uninstall
#
# -Dir, -BinDir, -DropHost and -Archive (a .zip you already have, instead of
# downloading one) take the same job as DROPBIN_HOME, DROPBIN_BIN, DROP_HOST
# and DROPBIN_ARCHIVE.
param(
  [string]$Version = $(if ($env:DROPBIN_VERSION) { $env:DROPBIN_VERSION } else { 'latest' }),
  [string]$Dir     = $(if ($env:DROPBIN_HOME) { $env:DROPBIN_HOME } else { "$env:LOCALAPPDATA\dropbin\app" }),
  [string]$BinDir  = $(if ($env:DROPBIN_BIN) { $env:DROPBIN_BIN } else { "$env:LOCALAPPDATA\dropbin\bin" }),
  [string]$DropHost,
  [string]$Archive = $(if ($env:DROPBIN_ARCHIVE) { $env:DROPBIN_ARCHIVE } else { '' }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # or Invoke-WebRequest crawls on 5.1

$Repo = 'dharunashokkumar/dropbin'
$Mark = 'dropbin-shim'                     # what tells our shim from another db

# Replaced with the request origin when a deployment serves this at
# /install.ps1, and left as the literal placeholder when it is fetched from
# GitHub. Testing for "http" rather than for the placeholder is deliberate: the
# substitution replaces *every* occurrence, so a second mention of the
# placeholder here would be rewritten along with the first.
if (-not $DropHost) {
  $served = '__HOST__'
  if ($served -like 'http*') { $DropHost = $served }
}
if ($DropHost) { $DropHost = $DropHost.TrimEnd('/') }

function Say  { param([string]$m, [string]$c) if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m } }
function Die  { param([string]$m) Write-Host "Error: $m" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------- uninstall ---

if ($Uninstall) {
  $gone = $false
  foreach ($name in 'db.cmd', 'dropbin.cmd') {
    $f = Join-Path $BinDir $name
    # Only ever remove a shim this script wrote. Somebody else's db.cmd stays.
    if ((Test-Path $f) -and ((Get-Content $f -Raw) -like "*$Mark*")) {
      Remove-Item $f -Force; Say "removed $f"; $gone = $true
    }
  }
  if ((Test-Path (Join-Path $Dir 'bin\db.js'))) {
    Remove-Item $Dir -Recurse -Force; Say "removed $Dir"; $gone = $true
  }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($user -and ($user -split ';' -contains $BinDir)) {
    $kept = ($user -split ';' | Where-Object { $_ -and $_ -ne $BinDir }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $kept, 'User')
    Say "removed $BinDir from your PATH"; $gone = $true
  }
  if (-not $gone) { Say 'nothing installed here.' }
  exit 0
}

# ---------------------------------------------------------------- checks ---

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'Node 18 or newer is required, and there is no node on the PATH.' Red
  Say ''
  Say '  Install Node from https://nodejs.org and run this again — or, for a'
  Say '  machine that will never have Node, use the client that needs nothing:'
  Say ''
  $h = if ($DropHost) { $DropHost } else { 'https://your-deployment' }
  Say "    irm $h/cli.ps1 -OutFile drop.ps1 ; ./drop.ps1" Cyan
  exit 1
}
$major = 0
if ((& node -v) -match '^v(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 18) { Die "Node 18 or newer is required; this is $(& node -v)." }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# --------------------------------------------------------------- install ---

$Version = $Version -replace '^v', ''
$url = if ($Version -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download/dropbin.zip"
} else {
  "https://github.com/$Repo/releases/download/v$Version/dropbin.zip"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dropbin-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  if ($Archive) {
    if (-not (Test-Path $Archive)) { Die "no such archive: $Archive" }
    Say "installing $Archive" DarkGray
    Copy-Item $Archive "$tmp\dropbin.zip"
  } else {
    Say "fetching $url" DarkGray
    try { Invoke-WebRequest -Uri $url -OutFile "$tmp\dropbin.zip" -UseBasicParsing }
    catch { Die "download failed — is $Version a released version? ($($_.Exception.Message))" }
  }

  Expand-Archive -Path "$tmp\dropbin.zip" -DestinationPath $tmp -Force
  if (-not (Test-Path "$tmp\package\bin\db.js")) { Die 'that archive is not the dropbin package.' }

  # Replace what is there rather than merging into it: a file dropped from one
  # release must not survive into the next.
  if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
  $parent = Split-Path $Dir -Parent
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Move-Item "$tmp\package" $Dir
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
$entry = Join-Path $Dir 'bin\db.js'
foreach ($name in 'db.cmd', 'dropbin.cmd') {
  $lines = @(
    '@echo off',
    "rem $Mark - written by the dropbin installer. Delete this and",
    "rem $Dir to uninstall, or re-run install.ps1 -Uninstall.",
    'setlocal'
  )
  # A default the environment still wins over, not a stored setting: `db`
  # itself writes nothing anywhere, and DROP_HOST keeps overriding it.
  if ($DropHost) { $lines += "if not defined DROP_HOST set ""DROP_HOST=$DropHost""" }
  $lines += "node ""$entry"" %*"
  # OEM, not ASCII: cmd reads a .cmd in the OEM code page, and a path with a
  # non-ASCII character in it (a username, usually) would otherwise be written
  # as question marks and the shim would point at nothing.
  Set-Content -Path (Join-Path $BinDir $name) -Value $lines -Encoding oem
}

$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $user) { $user = '' }
$onPath = $user -split ';' -contains $BinDir
if (-not $onPath) {
  [Environment]::SetEnvironmentVariable('Path', (($user.TrimEnd(';'), $BinDir) -join ';').TrimStart(';'), 'User')
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

$installed = 'unknown'
try { $installed = (& node $entry --version | Select-Object -First 1) } catch { }
if (-not $installed) { $installed = 'unknown' }

Say ''
Say "  dropbin $installed installed" Green
Say "    files  $Dir"
Say "    db     $(Join-Path $BinDir 'db.cmd')"
if ($DropHost) { Say "    host   $DropHost  (DROP_HOST overrides it)" }
# An npm install of the same tool leaves a `db` of its own on the PATH, and
# whichever comes first wins. Say so rather than let the wrong one answer.
$found = Get-Command db -ErrorAction SilentlyContinue
$mine = Join-Path $BinDir 'db.cmd'
if ($found -and $found.Source -and $found.Source -ne $mine) {
  Say ''
  Say "  Another db is earlier on your PATH and will answer first:" Yellow
  Say "    $($found.Source)"
  Say '  Remove it (npm rm -g dropbin) or put this one ahead of it.'
}

Say ''
if ($onPath) {
  Say '  Run db to start.'
} else {
  Say "  $BinDir was added to your PATH."
  Say '  It works in this window now; other terminals need to be reopened.'
  Say ''
  Say '  Then run db.'
}
Say ''
