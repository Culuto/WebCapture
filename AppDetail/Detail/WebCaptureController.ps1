param(
  [ValidateSet('boot','boot-background','stop','stop-background','reload','reload-background')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtimeDir = Join-Path $appRoot 'runtime'
$pidFile = Join-Path $runtimeDir 'server.pid.json'
$browserPidFile = Join-Path $runtimeDir 'browser.pid'
$url = 'http://127.0.0.1:43193/'
$healthUrl = 'http://127.0.0.1:43193/api/health'
$expectedVersion = (Get-Content -LiteralPath (Join-Path $appRoot 'app.config.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-AppReady {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return $response.app -eq 'WebCapture' -and $response.ready -eq $true -and $response.replayReady -eq $true -and $response.version -eq $expectedVersion
  } catch { return $false }
}

function Start-AppServer {
  if (Test-AppReady) { return }
  if (Test-Path -LiteralPath $pidFile) { Stop-AppServer }
  if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules'))) {
    Push-Location $appRoot
    try { & npm.cmd ci --no-audit --no-fund } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'WebCapture dependency install (npm ci) failed.' }
  }
  & node (Join-Path $appRoot 'scripts\sync-appdetail.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'WebCapture AppDetail sync failed.' }
  $stdout = Join-Path $runtimeDir 'server.stdout.log'
  $stderr = Join-Path $runtimeDir 'server.stderr.log'
  $serverFile = Join-Path $appRoot 'server\server.mjs'
  $process = Start-Process -FilePath 'node.exe' -ArgumentList @($serverFile) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $processStartTime = $process.StartTime.ToUniversalTime().ToString('o')
  @{ pid=$process.Id; root=$appRoot; serverFile=$serverFile; processStartTime=$processStartTime } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
  foreach ($attempt in 1..60) {
    Start-Sleep -Milliseconds 250
    if (Test-AppReady) { return }
    if ($process.HasExited) { throw "WebCapture server exited. See $stderr" }
  }
  if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  throw 'WebCapture server did not become ready.'
}

function Resolve-ProcessStartTime($value) {
  if ($value -is [datetime]) { return $value.ToUniversalTime() }
  return [datetime]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Stop-AppServer {
  if (-not (Test-Path -LiteralPath $pidFile)) { return }
  $state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
  if ([string]$state.root -ne $appRoot -or [string]$state.serverFile -ne (Join-Path $appRoot 'server\server.mjs')) { throw 'PID file root mismatch.' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.pid)" -ErrorAction SilentlyContinue
  if (-not $process) { Remove-Item -LiteralPath $pidFile -Force; return }
  $command = [string]$process.CommandLine
  $nativeProcess = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  $actualStart = if ($nativeProcess) { $nativeProcess.StartTime.ToUniversalTime() } else { $null }
  $expectedStart = Resolve-ProcessStartTime $state.processStartTime
  if ($command -notmatch [regex]::Escape((Join-Path $appRoot 'server\server.mjs')) -or -not $actualStart -or [math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 2) { throw 'PID ownership check failed.' }
  try {
    $session = Invoke-RestMethod -Uri 'http://127.0.0.1:43193/api/session' -TimeoutSec 2
    Invoke-RestMethod -Uri 'http://127.0.0.1:43193/api/system/shutdown' -Method Post -Headers @{ Origin='http://127.0.0.1:43193'; 'x-webcapture-csrf'=[string]$session.csrfToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 2 | Out-Null
    foreach ($attempt in 1..80) {
      if (-not (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 250
    }
  } catch {}
  if (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue) { & taskkill.exe /PID ([int]$state.pid) /T /F | Out-Null }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Start-AppWindow {
  if (Test-Path -LiteralPath $browserPidFile) {
    $existingPid = [int](Get-Content -LiteralPath $browserPidFile -Raw)
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    if ($existing -and [string]$existing.CommandLine -match [regex]::Escape((Join-Path $runtimeDir 'AppWindowProfile'))) { return }
    Remove-Item -LiteralPath $browserPidFile -Force -ErrorAction SilentlyContinue
  }
  $browserCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  $browserExe = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $browserExe) { throw 'WebCapture requires Google Chrome or Microsoft Edge for an owned app window.' }
  $profile = Join-Path $runtimeDir 'AppWindowProfile'
  $browser = Start-Process -FilePath $browserExe -ArgumentList @("--app=$url", "--user-data-dir=$profile") -PassThru
  Set-Content -LiteralPath $browserPidFile -Value $browser.Id -Encoding ascii
}

function Stop-AppWindow {
  if (-not (Test-Path -LiteralPath $browserPidFile)) { return }
  $browserPid = [int](Get-Content -LiteralPath $browserPidFile -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$browserPid" -ErrorAction SilentlyContinue
  if ($process -and [string]$process.CommandLine -match [regex]::Escape((Join-Path $runtimeDir 'AppWindowProfile'))) { & taskkill.exe /PID $browserPid /T /F | Out-Null }
  Remove-Item -LiteralPath $browserPidFile -Force -ErrorAction SilentlyContinue
}

switch ($Action) {
  'boot' { Start-AppServer; Start-AppWindow }
  'boot-background' { Start-AppServer }
  'stop' { Stop-AppWindow; Stop-AppServer }
  'stop-background' { Stop-AppServer }
  'reload' { Stop-AppWindow; Stop-AppServer; Start-AppServer; Start-AppWindow }
  'reload-background' { Stop-AppServer; Start-AppServer }
}
