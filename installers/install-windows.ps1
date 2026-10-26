# QuestHR installer for Windows 10/11 · creates the desktop icon and starts the server
$ErrorActionPreference = 'Stop'
$Pkg = Split-Path -Parent $PSScriptRoot
Write-Host ""
Write-Host "  QuestHR · Chandramari Group" -ForegroundColor Yellow
Write-Host "  Installing from $Pkg"
Write-Host ""

function NodeMajor { try { $v = (& node -v) 2>$null; if ($v -match '^v(\d+)') { return [int]$Matches[1] } } catch {} ; return 0 }
if ((NodeMajor) -lt 22) {
  Write-Host "Node.js 22 or newer is needed. Trying to install it with winget..." -ForegroundColor Cyan
  try { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Host } catch { Write-Host "winget is not available." }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  if ((NodeMajor) -lt 22) {
    Write-Host "Please install Node.js LTS from the page that opens, then run this installer again." -ForegroundColor Red
    Start-Process "https://nodejs.org/en/download"
    exit 1
  }
}
Write-Host ("Node.js " + (& node -v) + " found.") -ForegroundColor Green

# Where to keep data: live database on this computer, backups in Google Drive for desktop (pilot)
$drive = "$(& node "$Pkg\server\configure.js" --detect-drive)".Trim()
$data = Join-Path $env:LOCALAPPDATA 'QuestHR\data'
$backup = ''
if ($drive) {
  $ans = Read-Host "Google Drive for desktop found at $drive. Keep QuestHR backups there for the pilot? [Y/n]"
  if ($ans -eq '' -or $ans -match '^[Yy]') { $backup = Join-Path $drive 'QuestHR-Backups' }
} else {
  Write-Host "Google Drive for desktop was not found. Backups stay next to the data. Install it from https://www.google.com/drive/download/ to keep copies in Drive." -ForegroundColor Yellow
}
$custom = Read-Host "Data folder [$data] (press Enter to accept)"
if ($custom) { $data = $custom }
New-Item -ItemType Directory -Force -Path $data | Out-Null
if ($backup) { New-Item -ItemType Directory -Force -Path $backup | Out-Null; & node "$Pkg\server\configure.js" --data "$data" --backup "$backup" } else { & node "$Pkg\server\configure.js" --data "$data" }

# Desktop + Start menu icons
$ico = Join-Path $Pkg 'icons\questhr.ico'
$start = Join-Path $Pkg 'Start-QuestHR.bat'
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'QuestHR.lnk'))
  $lnk.TargetPath = $start; $lnk.WorkingDirectory = $Pkg; $lnk.IconLocation = "$ico,0"; $lnk.WindowStyle = 7
  $lnk.Description = 'QuestHR · Chandramari Group'; $lnk.Save()
}
Write-Host "QuestHR icon added to the Desktop and Start menu." -ForegroundColor Green

$auto = Read-Host "Start the QuestHR server automatically when this computer starts? [y/N]"
if ($auto -match '^[Yy]') {
  $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'QuestHR server.lnk'))
  $lnk.TargetPath = $start; $lnk.Arguments = 'nobrowser'; $lnk.WorkingDirectory = $Pkg; $lnk.IconLocation = "$ico,0"; $lnk.WindowStyle = 7; $lnk.Save()
  Write-Host "Auto-start enabled." -ForegroundColor Green
}

# Allow other computers on the network to connect (needs administrator rights; skipped quietly otherwise)
try { netsh advfirewall firewall add rule name="QuestHR" dir=in action=allow protocol=TCP localport=8080 | Out-Null; Write-Host "Firewall opened for port 8080." } catch { Write-Host "Tip: to let other computers connect, allow port 8080 in Windows Firewall (run this installer as administrator)." }

Write-Host ""
Write-Host "Done. Starting QuestHR..." -ForegroundColor Green
Start-Process -FilePath $start -WorkingDirectory $Pkg -WindowStyle Minimized
