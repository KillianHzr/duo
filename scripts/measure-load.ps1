# Measures CPU and RAM load of Duo instances in a call (fake microphone, muted output).
# Usage: pwsh scripts/measure-load.ps1 [-Hidden]   (requires: npm run build)
param([switch]$Hidden, [int]$Seconds = 20)

$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $env:TEMP 'duo-e2e-load.txt'
$env:DUO_E2E_DURATION = [string](($Seconds + 22) * 1000)
if ($Hidden) { $env:DUO_E2E_HIDE = '1' }
$job = Start-Process node -ArgumentList 'scripts/e2e-voice.mjs' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $log
$env:DUO_E2E_DURATION = $null
$env:DUO_E2E_HIDE = $null

function Get-Sample {
  $app = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like "$root\*" }
  $srv = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.ts*' }
  $cpu = { param($p) (($p | Measure-Object KernelModeTime -Sum).Sum + ($p | Measure-Object UserModeTime -Sum).Sum) / 1e7 }
  $mem = { param($p) ($p | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 } | Measure-Object -Sum).Sum / 1MB }
  [pscustomobject]@{ AppCpu = & $cpu $app; AppMem = & $mem $app; SrvCpu = & $cpu $srv; SrvMem = & $mem $srv; At = Get-Date }
}

Start-Sleep 14
$a = Get-Sample
Start-Sleep $Seconds
$b = Get-Sample
$elapsed = ($b.At - $a.At).TotalSeconds
$cores = [Environment]::ProcessorCount

$mode = if ($Hidden) { 'window hidden' } else { 'window visible' }
"Mode: $mode, measured over $([int]$elapsed) s, $cores logical cores"
"App (per instance): {0:N1} % of one core = {1:N2} % of total CPU; {2:N0} MB RAM" -f `
  (($b.AppCpu - $a.AppCpu) / $elapsed * 100 / 3), (($b.AppCpu - $a.AppCpu) / $elapsed * 100 / 3 / $cores), ($b.AppMem / 3)


$job.WaitForExit(90000) | Out-Null
Get-Content $log | Select-String 'FAIL|pass|failure'
