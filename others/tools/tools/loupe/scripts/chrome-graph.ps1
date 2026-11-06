# Opens loupe's graph in its own Chrome window (design 6.1.1). The adapter is fixed per Chrome process and a page cannot choose it, so the Radeon window
# is a separate process: `--force_low_power_gpu` only takes effect with its own --user-data-dir. Run this on Windows, not in WSL.
#   powershell -ExecutionPolicy Bypass -File chrome-graph.ps1                   RTX 4080 SUPER, the default host
#   powershell -ExecutionPolicy Bypass -File chrome-graph.ps1 -Radeon           AMD Radeon Graphics
#   powershell -ExecutionPolicy Bypass -File chrome-graph.ps1 -Url http://127.0.0.1:4813/#/graph
# For the bench: -ProfileName gives a fresh profile (first load, empty shader cache), -ExposeGc turns on the gc heap reading.
param(
  [string]$Url = 'http://127.0.0.1:4812/#/graph',
  [switch]$Radeon,
  [string]$ProfileName = '',
  [switch]$ExposeGc
)
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'chrome.exe not found' }
$profileName = if ($ProfileName) { $ProfileName } elseif ($Radeon) { 'loupe-chrome-radeon' } else { 'loupe-chrome' }
$chromeArgs = @("--user-data-dir=`"$env:LOCALAPPDATA\$profileName`"", '--new-window', "--app=$Url")
if ($Radeon) { $chromeArgs += '--force_low_power_gpu' }
if ($ExposeGc) { $chromeArgs += '--js-flags=--expose-gc' }
Start-Process -FilePath $chrome -ArgumentList $chromeArgs
