@echo off
set "REGISTER_DEFAULT_APP_SCRIPT=%~f0"
set "REGISTER_DEFAULT_APP_ARGS=%*"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$text = Get-Content -LiteralPath $env:REGISTER_DEFAULT_APP_SCRIPT -Raw; $parts = [regex]::Split($text, '(?m)^# POWERSHELL_START\r?$', 2); Invoke-Expression $parts[1]"
exit /b %ERRORLEVEL%

# POWERSHELL_START
$ErrorActionPreference = 'Stop'

$appName = 'Video Player'
$appExeName = 'video-player-tauri.exe'
$progId = 'VideoPlayerTauri.VideoFile'
$extensions = @('mp4', 'webm', 'mov', 'mkv', 'avi', 'flv', 'm4v', 'wmv', 'ts', 'mpg', 'mpeg', '3gp')
$dryRun = $env:REGISTER_DEFAULT_APP_ARGS -match '(^|\s)--dry-run(\s|$)'

$root = Split-Path -Parent $env:REGISTER_DEFAULT_APP_SCRIPT
$appExe = Join-Path $root "src-tauri\target\release\$appExeName"

if (-not (Test-Path -LiteralPath $appExe)) {
    $installDir = Get-ItemPropertyValue -Path 'HKCU:\Software\slaur\Video Player' -Name 'InstallDir' -ErrorAction SilentlyContinue
    if ($installDir) {
        $appExe = Join-Path $installDir $appExeName
    }
}

if (-not (Test-Path -LiteralPath $appExe)) {
    Write-Host "Could not find $appExeName."
    Write-Host ''
    Write-Host 'Build the app first, install it, or edit this file and set $appExe to the full path.'
    Write-Host "Expected: $appExe"
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 1
}

$openCommand = '"' + $appExe + '" "%1"'
$base = [Microsoft.Win32.Registry]::CurrentUser

function Set-HkcuValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Name = '',
        [AllowEmptyString()][string]$Value = ''
    )

    if ($dryRun) {
        $label = if ($Name) { $Name } else { '(Default)' }
        Write-Host "HKCU\$Path :: $label = $Value"
        return
    }

    $key = $base.CreateSubKey($Path)
    if (-not $key) {
        throw "Failed to create HKCU\$Path"
    }

    try {
        $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $key.Close()
    }
}

Write-Host "Registering `"$appName`" as a selectable Windows default app..."
Write-Host "App executable: $appExe"
Write-Host ''

Set-HkcuValue "Software\Classes\$progId" '' "$appName video file"
Set-HkcuValue "Software\Classes\$progId" 'FriendlyTypeName' "$appName video file"
Set-HkcuValue "Software\Classes\$progId\DefaultIcon" '' "$appExe,0"
Set-HkcuValue "Software\Classes\$progId\shell\open\command" '' $openCommand

Set-HkcuValue "Software\Classes\Applications\$appExeName" 'FriendlyAppName' $appName
Set-HkcuValue "Software\Classes\Applications\$appExeName" 'ApplicationIcon' "$appExe,0"
Set-HkcuValue "Software\Classes\Applications\$appExeName\shell\open\command" '' $openCommand
Set-HkcuValue "Software\Classes\Applications\$appExeName\Capabilities" 'ApplicationName' $appName
Set-HkcuValue "Software\Classes\Applications\$appExeName\Capabilities" 'ApplicationDescription' 'Minimalist video player'
Set-HkcuValue "Software\Classes\Applications\$appExeName\Capabilities" 'ApplicationIcon' "$appExe,0"

foreach ($extension in $extensions) {
    Set-HkcuValue "Software\Classes\Applications\$appExeName\SupportedTypes" ".$extension" ''
    Set-HkcuValue "Software\Classes\Applications\$appExeName\Capabilities\FileAssociations" ".$extension" $progId
}

Set-HkcuValue 'Software\RegisteredApplications' $appName "Software\Classes\Applications\$appExeName\Capabilities"

if (-not $dryRun) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ShellNotify {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
        [ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    } catch {
        Write-Host "Windows registry refresh skipped: $($_.Exception.Message)"
    }

    Start-Process 'ms-settings:defaultapps'
}

Write-Host ''
Write-Host "Done. In Settings, choose `"$appName`" for the video types you want."
Write-Host "You can also right-click a video file, choose Open with, then choose `"$appName`"."
Write-Host ''

if (-not $dryRun) {
    Read-Host 'Press Enter to close'
}
