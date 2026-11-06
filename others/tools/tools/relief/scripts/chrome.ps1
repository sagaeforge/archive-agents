# Opens relief in its own Chrome window (design 11). `relief open` calls this from WSL; it runs on the Windows side.
param(
  [ValidatePattern('^http://127\.0\.0\.1:\d+/$')]
  [string]$Url = 'http://127.0.0.1:4815/'
)
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'chrome.exe not found' }
$chromeArgs = @("--user-data-dir=`"$env:LOCALAPPDATA\relief-chrome`"", '--new-window', "--app=$Url")
Start-Process -FilePath $chrome -ArgumentList $chromeArgs
