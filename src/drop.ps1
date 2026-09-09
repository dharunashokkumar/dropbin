# dropbin — upload something, or download something. That is the whole tool.
#
#   irm __HOST__/cli.ps1 -OutFile drop.ps1 ; ./drop.ps1
#
# It asks for the password once, then shows two options. Set $env:DROP_PASS to
# skip the prompt. Downloads land in the directory you started it from.
#
# Pass arguments and it skips the menu:
#   ./drop.ps1 up PATH [PIN] | get PIN [DIR] | view PIN | rm PIN | free
param(
  [Parameter(Position = 0)][string]$Cmd,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$Base = if ($env:DROP_HOST) { $env:DROP_HOST } else { '__HOST__' }
if ($null -eq $Rest) { $Rest = @() }
$Pass = $env:DROP_PASS
$Tmp = $null

# ------------------------------------------------------------------ plumbing

function Enc([string]$s) { [uri]::EscapeDataString($s) }

function Web([string]$path, [hashtable]$extra = @{}) {
  $req = @{ Uri = "$Base/$path"; Headers = @{ 'X-Pass' = $Pass }; UseBasicParsing = $true }
  foreach ($k in $extra.Keys) { $req[$k] = $extra[$k] }
  if ($extra.ContainsKey('Headers')) { $req.Headers = $extra.Headers + @{ 'X-Pass' = $Pass } }
  Invoke-WebRequest @req
}
function WebText([string]$path) { (Web $path).Content }
function Reason($e) { if ($e.ErrorDetails.Message) { $e.ErrorDetails.Message.Trim() } else { $e.Exception.Message } }

function TempDir {
  if (-not $script:Tmp) {
    $script:Tmp = Join-Path ([IO.Path]::GetTempPath()) ("dropbin-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $script:Tmp -Force | Out-Null
  }
  return $script:Tmp
}
function Cleanup {
  if ($script:Tmp -and (Test-Path $script:Tmp)) { Remove-Item -Recurse -Force $script:Tmp -ErrorAction SilentlyContinue }
}

function Ask-Pass {
  while ($true) {
    if (-not $Pass) {
      if ([Console]::IsInputRedirected) {
        $s = [Console]::In.ReadLine()
        $script:Pass = if ($null -eq $s) { '' } else { $s.Trim() }
      }
      else {
        $sec = Read-Host -Prompt 'password' -AsSecureString
        $script:Pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
          [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
      }
      # Nothing typed means nothing is coming; looping here would just spin.
      if (-not $script:Pass) { Write-Host 'no password given' -ForegroundColor Red; exit 1 }
    }
    try { Web '?info=1' | Out-Null; return }
    catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 401) {
        Write-Host 'wrong password' -ForegroundColor Red
        $script:Pass = ''
      }
      else { Write-Host "cannot reach $Base - $(Reason $_)" -ForegroundColor Red; exit 1 }
    }
  }
}

function HSize([double]$n) {
  $u = @('B', 'KB', 'MB', 'GB', 'TB'); $i = 0
  while ($n -ge 1024 -and $i -lt 4) { $n /= 1024; $i++ }
  if ($i -eq 0) { return ('{0:0} {1}' -f $n, $u[$i]) }
  return ('{0:0.00} {1}' -f $n, $u[$i])
}

function Bar([double]$used, [double]$total) {
  $w = 22
  $n = if ($total -gt 0) { [Math]::Round($used / $total * $w) } else { 0 }
  if ($n -gt $w) { $n = $w }
  return '[' + ('#' * $n) + ('.' * ($w - $n)) + ']'
}

# The markers a file browser has always used.
function Tag([string]$name) {
  switch -Regex ([IO.Path]::GetExtension($name).TrimStart('.').ToLower()) {
    '^(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|heic)$' { return '[IMG]' }
    '^(mp4|webm|mov|mkv)$' { return '[VID]' }
    '^(mp3|wav|ogg|m4a)$' { return '[SND]' }
    '^pdf$' { return '[PDF]' }
    '^(zip|tgz|gz|tar|7z|rar)$' { return '[ZIP]' }
    '^(txt|md|log|csv|json|js|mjs|ts|py|rb|go|rs|sh|bash|c|h|cpp|java|php|sql|yml|yaml|toml|ini|conf|html|css|xml)$' { return '[TXT]' }
    default { return '[   ]' }
  }
}
function Readable([string]$name) { return (Tag $name) -eq '[TXT]' }

# Pack a folder before it leaves the machine, so a pin still holds one thing.
function Pack([string]$dir) {
  $d = (Resolve-Path $dir).Path.TrimEnd('\', '/')
  $zip = Join-Path (TempDir) ((Split-Path -Leaf $d) + '.zip')
  Compress-Archive -Path $d -DestinationPath $zip -Force
  return $zip
}

# Never write over something that is already sitting there.
function FreeName([string]$path) {
  if (-not (Test-Path $path)) { return $path }
  $i = 1
  while (Test-Path "$path.$i") { $i++ }
  return "$path.$i"
}

function Save-To([string]$path, [string]$out) {
  $dir = Split-Path -Parent $out
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Web $path @{ OutFile = $out } | Out-Null
}

# --------------------------------------------------------------------- input

# Read-Host hands back an empty string at end of input instead of failing, so a
# menu built on it spins forever once stdin runs dry. Read the stream directly
# when it is redirected: $null means EOF, and EOF means quit.
function ReadIn {
  if ([Console]::IsInputRedirected) { return [Console]::In.ReadLine() }
  return (Read-Host)
}

function Choice([string]$prompt) {
  if ([Console]::IsInputRedirected) {
    $s = ReadIn
    if ($null -eq $s) { return 'q' }
    $s = $s.Trim()
    if (-not $s) { return '.' }
    return $s.Substring(0, 1)
  }
  Write-Host " $prompt " -NoNewline -ForegroundColor DarkGray
  $k = [Console]::ReadKey($true)
  Write-Host ''
  return "$($k.KeyChar)"
}

function Ask([string]$prompt) {
  Write-Host " $prompt " -NoNewline
  $s = ReadIn
  if ($null -eq $s) { return '' }
  return $s.Trim().Trim('"').Trim("'")
}

function Pause-Key {
  Write-Host ''
  if ([Console]::IsInputRedirected) { ReadIn | Out-Null }
  else { Write-Host ' press any key' -ForegroundColor DarkGray; [void][Console]::ReadKey($true) }
}

function Top {
  try { Clear-Host } catch { }
  Write-Host ' dropbin ' -NoNewline -ForegroundColor White
  Write-Host ($Base -replace '^\w+://', '') -ForegroundColor DarkGray
  Write-Host (' ' + ('-' * 60)) -ForegroundColor DarkGray
}
function Item([string]$k, [string]$label, [string]$note) {
  Write-Host "   $k" -NoNewline -ForegroundColor White
  Write-Host ("  " + $label.PadRight(11)) -NoNewline
  Write-Host $note -ForegroundColor DarkGray
}

# -------------------------------------------------------------------- upload

function Do-Upload {
  Top
  Write-Host ''
  Write-Host ' Upload' -ForegroundColor White
  Write-Host ''
  Item '1' 'file' ''
  Item '2' 'folder' '(zipped before it is sent)'
  Item 'q' 'back' ''
  Write-Host ''
  $k = Choice '1/2/q'
  $kind = switch ($k) { '1' { 'file' } '2' { 'folder' } default { $null } }
  if (-not $kind) { return }

  $path = Ask "$kind to upload:"
  if (-not $path) { return }

  $send = $null
  if ($kind -eq 'file') {
    if (-not (Test-Path $path -PathType Leaf)) {
      Write-Host " not a file: $path" -ForegroundColor Red; Pause-Key; return
    }
    $send = (Resolve-Path $path).Path
  }
  else {
    if (-not (Test-Path $path -PathType Container)) {
      Write-Host " not a folder: $path" -ForegroundColor Red; Pause-Key; return
    }
    Write-Host " packing $path ..." -ForegroundColor DarkGray
    try { $send = Pack $path }
    catch { Write-Host " could not pack it - $(Reason $_)" -ForegroundColor Red; Pause-Key; return }
  }
  $name = Split-Path -Leaf $send

  Write-Host ''
  Item '1' 'random pin' '(4 digits)'
  Item '2' 'custom pin' '(anything you like)'
  Write-Host ''
  $k = Choice '1/2/q'
  $pin = ''
  if ($k -eq '2') {
    $pin = Ask 'pin:'
    if (-not $pin) { Write-Host ' no pin given' -ForegroundColor Red; Pause-Key; return }
  }
  elseif ($k -ne '1') { return }

  Write-Host ''
  Write-Host " sending $name ..." -ForegroundColor DarkGray
  try {
    $pin = (Web 'up?quiet=1' @{ Method = 'Put'; InFile = $send
        Headers = @{ 'X-Name' = $name; 'X-Pin' = $pin } }).Content.Trim()
  }
  catch { Write-Host " upload failed - $(Reason $_)" -ForegroundColor Red; Pause-Key; return }

  $size = (Get-Item $send).Length
  Top
  Write-Host ''
  Write-Host ' Uploaded' -ForegroundColor White
  Write-Host ''
  Write-Host '   pin    ' -NoNewline; Write-Host $pin -ForegroundColor White
  Write-Host "   file   $(Tag $name) $name   $(HSize $size)"
  Write-Host "   url    $Base/$(Enc $pin)"
  Pause-Key
}

# ------------------------------------------------------------------ download

# Ask what a pin holds before touching any bytes.
function Peek([string]$pin) {
  try { $line = WebText "$(Enc $pin)?info=1" } catch { return $null }
  $c = $line.Trim() -split "`t"
  if (-not $c[0]) { return $null }
  return @{ Name = $c[0]; Size = [long]$c[1]; Date = $(if ($c.Count -gt 2) { $c[2] } else { '' }) }
}

function Do-Download {
  Top
  Write-Host ''
  Write-Host ' Download' -ForegroundColor White
  Write-Host ''
  $pin = Ask 'pin:'
  if (-not $pin) { return }

  $hit = Peek $pin
  if (-not $hit) { Write-Host " no such pin: $pin" -ForegroundColor Red; Pause-Key; return }

  while ($true) {
    Top
    Write-Host ''
    Write-Host ' Download' -NoNewline -ForegroundColor White
    Write-Host "   pin $pin" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host "   $(Tag $hit.Name) $($hit.Name)   $(HSize $hit.Size)   $($hit.Date)"
    Write-Host ''
    Item '1' 'download' 'into the current directory'
    if (Readable $hit.Name) { Item '2' 'view' 'here' }
    Item 'q' 'back' ''
    Write-Host ''
    $k = Choice '1/2/q'
    if ($k -eq '1') {
      $out = FreeName (Join-Path '.' $hit.Name)
      Write-Host ''
      Write-Host " saving $out ..." -ForegroundColor DarkGray
      try { Save-To (Enc $pin) $out; Write-Host " saved $out" -ForegroundColor White }
      catch { Write-Host " download failed - $(Reason $_)" -ForegroundColor Red }
      Pause-Key
    }
    elseif ($k -eq '2' -and (Readable $hit.Name)) {
      try { Clear-Host } catch { }
      try { WebText "$(Enc $pin)?view=1" | Out-Host -Paging }
      catch { Write-Host (Reason $_) -ForegroundColor Red }
      Pause-Key
    }
    else { return }
  }
}

# ---------------------------------------------------------------------- menu

function Menu {
  while ($true) {
    $info = $null
    try { $info = (WebText '?info=1').Trim() -split "`t" } catch { }
    Top
    Write-Host ''
    Item '1' 'upload' 'a file or a folder'
    Item '2' 'download' 'with a pin'
    Write-Host ''
    Write-Host (' ' + ('-' * 60)) -ForegroundColor DarkGray
    if ($info -and $info.Count -ge 3) {
      $used = [double]$info[1]; $cap = [double]$info[2]
      Write-Host (' ' + (Bar $used $cap)) -NoNewline
      Write-Host ("  $(HSize ($cap - $used)) free of $(HSize $cap)") -NoNewline
      Write-Host ("   $($info[0]) pin(s) stored") -ForegroundColor DarkGray
    }
    Write-Host ' 1 or 2 to choose, q to quit' -ForegroundColor DarkGray
    switch (Choice '1/2/q') {
      '1' { Do-Upload }
      '2' { Do-Download }
      'q' { return }
      'Q' { return }
      default { }
    }
  }
}

# ---------------------------------------------------------------- scriptable

function Usage {
  Write-Host @'
dropbin - run it with no arguments for the two-option menu.

  drop.ps1                  upload or download, interactively
  drop.ps1 up PATH [PIN]    send a file or a folder; a folder is zipped first
  drop.ps1 get PIN [DIR]    save what the pin holds (default: here)
  drop.ps1 view PIN         print what the pin holds
  drop.ps1 rm PIN           throw a pin away
  drop.ps1 free             how much room is left

  $env:DROP_PASS = '...'    skip the password prompt
  $env:DROP_HOST = '...'    point at another deployment
'@
  exit 2
}

function Script-Mode {
  $a1 = if ($Rest.Count -ge 1) { $Rest[0] } else { '' }
  $a2 = if ($Rest.Count -ge 2) { $Rest[1] } else { '' }

  switch ($Cmd) {
    { $_ -in 'up', 'put', 'upload' } {
      if (-not $a1) { Usage }
      $send = ''
      if (Test-Path $a1 -PathType Container) { $send = Pack $a1 }
      elseif (Test-Path $a1 -PathType Leaf) { $send = (Resolve-Path $a1).Path }
      else { Write-Host "no such file or folder: $a1" -ForegroundColor Red; exit 1 }
      $name = Split-Path -Leaf $send
      $pin = (Web 'up?quiet=1' @{ Method = 'Put'; InFile = $send
          Headers = @{ 'X-Name' = $name; 'X-Pin' = $a2 } }).Content.Trim()
      Write-Host "  pin  $pin"
      Write-Host "  file $name"
      Write-Host "  url  $Base/$(Enc $pin)"
    }

    { $_ -in 'get', 'dl', 'download' } {
      if (-not $a1) { Usage }
      $hit = Peek $a1
      if (-not $hit) { Write-Host "no such pin: $a1" -ForegroundColor Red; exit 1 }
      $dir = if ($a2) { $a2 } else { '.' }
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $out = FreeName (Join-Path $dir $hit.Name)
      Save-To (Enc $a1) $out
      Write-Host "  $out"
    }

    { $_ -in 'view', 'cat' } {
      if (-not $a1) { Usage }
      WebText "$(Enc $a1)?view=1"
    }

    { $_ -in 'rm', 'del', 'delete' } {
      if (-not $a1) { Usage }
      (Web (Enc $a1) @{ Method = 'Delete' }).Content.Trim()
    }

    { $_ -in 'free', 'df', 'space' } {
      $c = (WebText '?info=1').Trim() -split "`t"
      $used = [double]$c[1]; $cap = [double]$c[2]
      Write-Host "  $(HSize $used) used, $(HSize ($cap - $used)) free of $(HSize $cap) across $($c[0]) pin(s)"
    }

    default { Usage }
  }
}

# ------------------------------------------------------------------- start --

try {
  Ask-Pass
  if ($Cmd) {
    try { Script-Mode }
    catch { Write-Host (Reason $_) -ForegroundColor Red; exit 1 }
  }
  else { Menu }
}
finally { Cleanup }
