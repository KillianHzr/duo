# Measures the CPU and RAM load of two instances in a call (fake microphone, muted output,
# loopback only, no window shown), broken down by process: main, window, audio, GPU, network.
# Usage: pwsh scripts/measure-load.ps1 [-Seconds 20] [-Enhanced] [-Gate]   (requires: npm run build)
param([int]$Seconds = 20, [switch]$Enhanced, [switch]$Gate, [switch]$Ui)

$root = Split-Path $PSScriptRoot -Parent
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$port = 47904
$duration = ($Seconds + 16) * 1000

function Start-Instance($name, [switch]$HostIt) {
  $data = Join-Path $env:TEMP "duo-load-$name-$PID"
  $env:DUO_E2E_NAME = $name
  $env:DUO_E2E_SERVER = "ws://127.0.0.1:$port"
  $env:DUO_E2E_CODE = 'LOAD42'
  $env:DUO_E2E_DURATION = [string]$duration
  $env:DUO_E2E_USERDATA = $data
  $env:DUO_E2E_HOST_PORT = if ($HostIt) { [string]$port } else { $null }
  $env:DUO_E2E_DATA = if ($HostIt) { Join-Path $data 'data' } else { $null }
  $env:DUO_E2E_ENHANCED = if ($Enhanced) { '1' } else { $null }
  $env:DUO_E2E_GATE = if ($Gate) { '-60' } else { $null }
  # -Ui draws the real interface, in a window placed beyond the screens.
  $env:DUO_E2E_UI = if ($Ui) { '1' } else { $null }
  $out = Join-Path $env:TEMP "duo-load-$name-$PID.txt"
  $env:ELECTRON_RUN_AS_NODE = $null
  $started = Get-Date
  $process = Start-Process $electron -ArgumentList '.' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out
  [pscustomobject]@{ Process = $process; Data = $data; Started = $started; Out = $out }
}

$instances = @((Start-Instance 'Alice' -HostIt))
Start-Sleep 3
$instances += Start-Instance 'Bob'
foreach ($name in 'DUO_E2E_NAME', 'DUO_E2E_SERVER', 'DUO_E2E_CODE', 'DUO_E2E_DURATION', 'DUO_E2E_USERDATA', 'DUO_E2E_HOST_PORT', 'DUO_E2E_DATA', 'DUO_E2E_ENHANCED', 'DUO_E2E_GATE', 'DUO_E2E_UI') {
  Remove-Item "env:$name" -ErrorAction SilentlyContinue
}

function Get-Sample {
  $all = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*duo-load-*-$PID*" -or $instances.Process.Id -contains $_.ProcessId }
  $rows = foreach ($p in $all) {
    $kind = if ($p.CommandLine -match '--type=renderer') { 'window' }
      elseif ($p.CommandLine -match '--type=gpu-process') { 'gpu' }
      elseif ($p.CommandLine -match 'audio\.mojom') { 'audio' }
      elseif ($p.CommandLine -match 'network\.mojom') { 'network' }
      elseif ($p.CommandLine -match '--type=') { 'other' }
      else { 'main' }
    $mem = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 / 1MB
    [pscustomobject]@{ Kind = $kind; Cpu = ($p.KernelModeTime + $p.UserModeTime) / 1e7; Mem = $mem }
  }
  [pscustomobject]@{ Rows = $rows; At = Get-Date }
}

Start-Sleep 9
$a = Get-Sample
Start-Sleep $Seconds
$b = Get-Sample
$elapsed = ($b.At - $a.At).TotalSeconds
$cores = [Environment]::ProcessorCount
$count = $instances.Count

"Two instances in a call, measured over $([int]$elapsed) s, $cores logical cores. Figures are per instance."
$total = 0; $totalMem = 0
foreach ($kind in 'main', 'window', 'audio', 'gpu', 'network', 'other') {
  $cpu = ((($b.Rows | Where-Object Kind -eq $kind | Measure-Object Cpu -Sum).Sum) - (($a.Rows | Where-Object Kind -eq $kind | Measure-Object Cpu -Sum).Sum)) / $elapsed * 100 / $count
  $mem = (($b.Rows | Where-Object Kind -eq $kind | Measure-Object Mem -Sum).Sum) / $count
  $total += $cpu; $totalMem += $mem
  "{0,-8} {1,5:N1} % of one core   {2,5:N0} MB" -f $kind, $cpu, $mem
}
"{0,-8} {1,5:N1} % of one core   {2,5:N0} MB   ({3:N2} % of total CPU)" -f 'TOTAL', $total, $totalMem, ($total / $cores)

foreach ($instance in $instances) {
  $instance.Process.WaitForExit(40000) | Out-Null
  if (-not $instance.Process.HasExited) { Stop-Process -Id $instance.Process.Id -Force -ErrorAction SilentlyContinue }
  Get-Content $instance.Out -ErrorAction SilentlyContinue | Select-String 'UI_PROBE'
  Remove-Item $instance.Out -ErrorAction SilentlyContinue
  Remove-Item $instance.Data -Recurse -Force -ErrorAction SilentlyContinue
}
