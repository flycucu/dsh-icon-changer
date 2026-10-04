#Requires -Version 5.1
<#
    Make Windows actually redraw the app icon after the exe has been rewritten.

    Rewriting the exe is not enough: Explorer keeps serving cached icon bitmaps, so
    the desktop, the taskbar and the Start Menu keep showing the old icon. A plain
    Explorer restart does NOT reliably help either, because the icon cache databases
    under %LOCALAPPDATA%\Microsoft\Windows\Explorer survive it. What does work:

      1. ie4uinit.exe -show                     cheap cache invalidation
      2. stop Explorer, then delete iconcache_*.db immediately - WINLOGON's
         AutoRestartShell brings Explorer back within about a second, so the delete
         has to be raced with a retry loop, otherwise the files are locked again
      3. start Explorer if the system did not already
      4. broadcast SHCNE_ASSOCCHANGED so the shell re-reads icons

    Every step is best effort and logged; the exit code stays 0 unless the cache
    purge could not remove a single file. ASCII-only on purpose: Windows
    PowerShell 5.1 mangles non-ASCII script files that have no BOM.
#>
[CmdletBinding()]
param(
    [string]$Log,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$message) {
    if (-not $Log) { return }
    try {
        Add-Content -LiteralPath $Log -Value ("[{0}] [shell] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8
    } catch { }
}

function Invoke-AssocChanged {
    try {
        Add-Type -Namespace DshShellRefresh -Name Notify -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
        [DshShellRefresh.Notify]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)
        Write-Log 'broadcast SHCNE_ASSOCCHANGED'
    } catch {
        Write-Log "broadcast failed: $($_.Exception.Message)"
    }
}

# --- 1. the cheap half ------------------------------------------------------ #
$ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path -LiteralPath $ie4uinit) {
    try {
        & $ie4uinit -show 2>$null | Out-Null
        Write-Log 'ie4uinit -show ran'
    } catch {
        Write-Log "ie4uinit failed: $($_.Exception.Message)"
    }
}

# --- 2. the half that actually matters -------------------------------------- #
$cacheDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$wanted = @('iconcache_16.db', 'iconcache_32.db', 'iconcache_48.db',
            'iconcache_256.db', 'iconcache_wide.db', 'iconcache_idx.db')
$targets = @()
foreach ($file in $wanted) {
    $path = Join-Path $cacheDir $file
    if (Test-Path -LiteralPath $path) { $targets += $path }
}

if ($DryRun) {
    Write-Log ("dry run: would purge {0} cache file(s)" -f $targets.Count)
    Invoke-AssocChanged
    exit 0
}

$removed = 0
if ($targets.Count -gt 0) {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Write-Log 'explorer stopped for the cache purge'
    foreach ($path in $targets) {
        for ($attempt = 0; $attempt -lt 25; $attempt++) {
            if (-not (Test-Path -LiteralPath $path)) { $removed++; break }
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $path)) { $removed++; break }
            Start-Sleep -Milliseconds 120
        }
    }
    Write-Log ("icon cache purge: {0}/{1} file(s) removed" -f $removed, $targets.Count)
} else {
    Write-Log 'no icon cache files to purge'
}

# --- 3. make sure the shell is back ----------------------------------------- #
Start-Sleep -Milliseconds 400
if (Get-Process -Name explorer -ErrorAction SilentlyContinue) {
    Write-Log 'explorer already running (AutoRestartShell)'
} else {
    try {
        (New-Object -ComObject WScript.Shell).Run('explorer.exe', 0, $false)
        Write-Log 'explorer started'
    } catch {
        try {
            Start-Process explorer.exe
            Write-Log 'explorer started (fallback)'
        } catch {
            Write-Log "could not start explorer: $($_.Exception.Message)"
        }
    }
}

# --- 4. tell the shell to re-read ------------------------------------------- #
Invoke-AssocChanged
Write-Log 'done'

if ($targets.Count -gt 0 -and $removed -eq 0) { exit 1 }
exit 0
