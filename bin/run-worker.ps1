#Requires -Version 5.1
<#
    Bootstrap for a queued icon job.

    Started by wmi-spawn.ps1, so it is NOT a child of DeepSeek Harness and not part
    of that process's job object: it keeps running after the app kills itself to
    release its own .exe.

    Reads the job description written by the host half (lib/index.js, pending-job
    .json) and hands the values to apply-icon.ps1, which does the waiting, the
    rewrite, the verification and the optional relaunch.

    ASCII-only on purpose: Windows PowerShell 5.1 mangles non-ASCII script files
    that have no BOM. Job values may be non-ASCII; they arrive through the JSON
    file, which is read explicitly as UTF8. Console text comes from messages.txt
    (see console-messages.ps1).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Job
)

$ErrorActionPreference = 'Stop'

# Lock this console's input down completely.
#
# Why: Windows pauses the whole console while the user drags a text selection in it
# (QuickEdit "mark" mode), and this window is *made* to be looked at. That is not
# theoretical: one click in it froze a job mid-flight, the exe was never rewritten
# and the queued request was lost (the console title even grew a "Select " prefix).
#
# A WMI-created console starts with input mode 0x01F7. First the QuickEdit bit was
# cleared (0x01B7), which makes clicking harmless; now the whole input mode is set to
# 0 - ENABLE_PROCESSED_INPUT / ENABLE_LINE_INPUT / ENABLE_ECHO_INPUT / ENABLE_WINDOW_INPUT
# / ENABLE_MOUSE_INPUT / ENABLE_QUICK_EDIT_MODE all off - so the console stops handing
# input to this process at all:
#   * mouse clicks and drag-selection do nothing (no mark mode, nothing to pause)
#   * keystrokes are ignored, so stray typing cannot disturb the job
#   * Ctrl+C is no longer turned into a signal (ENABLE_PROCESSED_INPUT is off), so an
#     accidental Ctrl+C cannot abort a rewrite either
# Output is unaffected: this only touches the input buffer. Nothing in this worker
# ever reads from the console.
try {
    Add-Type -Namespace DshConsoleMode -Name Api -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
    $stdIn = [DshConsoleMode.Api]::GetStdHandle(-10)            # STD_INPUT_HANDLE
    $consoleMode = [uint32]0
    if ([DshConsoleMode.Api]::GetConsoleMode($stdIn, [ref]$consoleMode)) {
        [void][DshConsoleMode.Api]::SetConsoleMode($stdIn, [uint32]0)
    }
} catch { }

# Seal the window itself.
#
# The input lock above only covers the client area; the title bar is managed by the
# window manager. A window that says "do not close me" but closes on one stray click
# is a trap, so the Close item is removed from the window's system menu - the X button
# and Alt+F4 (which posts the same SC_CLOSE) both stop working.
# Task Manager stays as the escape hatch if a job ever really hangs; that is
# deliberate, and it is also why minimize/maximize/move are left alone.
try {
    Add-Type -Namespace DshConsoleWindow -Name Api -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);
[DllImport("user32.dll")] public static extern bool DeleteMenu(IntPtr hMenu, uint uPosition, uint uFlags);
[DllImport("user32.dll")] public static extern bool DrawMenuBar(IntPtr hWnd);
'@
    $hwnd = [DshConsoleWindow.Api]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
        $sysMenu = [DshConsoleWindow.Api]::GetSystemMenu($hwnd, $false)
        if ($sysMenu -ne [IntPtr]::Zero) {
            # SC_CLOSE = 0xF060, MF_BYCOMMAND = 0x00000000
            [void][DshConsoleWindow.Api]::DeleteMenu($sysMenu, 0xF060, 0)
            [void][DshConsoleWindow.Api]::DrawMenuBar($hwnd)
        }
    }
} catch { }

# This window is the only thing the user sees while the icon is being changed, so
# say what is going on and warn that closing it kills the job. Text comes from
# messages.txt via console-messages.ps1, with ASCII fallbacks if that file is gone.
. (Join-Path $PSScriptRoot 'console-messages.ps1')
if (-not (Get-Command Get-DshText -ErrorAction SilentlyContinue)) {
    function Get-DshText { param([int]$Index, [string]$Fallback) return $Fallback }
    function Write-DshText { param([string]$Text) try { Write-Host $Text } catch { } }
    function Set-DshWindowTitle { param([string]$Text) }
}

$headline = Get-DshText -Index 0 -Fallback 'Changing the app icon - do not close this window'
Set-DshWindowTitle -Text $headline
Write-DshText -Text ''
Write-DshText -Text ('  ' + $headline)
Write-DshText -Text ''

$worker = Join-Path $PSScriptRoot 'apply-icon.ps1'
if (-not (Test-Path -LiteralPath $worker)) {
    Write-DshText -Text (Get-DshText -Index 5 -Fallback 'worker script missing')
    exit 2
}
if (-not (Test-Path -LiteralPath $Job)) {
    Write-DshText -Text (Get-DshText -Index 5 -Fallback 'job file missing')
    exit 3
}

try {
    $cfg = Get-Content -LiteralPath $Job -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-DshText -Text (Get-DshText -Index 5 -Fallback 'job file could not be read')
    exit 4
}

Write-DshText -Text ('  ' + (Get-DshText -Index 1 -Fallback 'waiting for the app to exit'))

$arguments = @{
    Op          = [string]$cfg.op
    Exe         = [string]$cfg.exe
    State       = [string]$cfg.state
    Log         = [string]$cfg.log
    BackupDir   = [string]$cfg.backupDir
    Rcedit      = [string]$cfg.rcedit
    Restart     = [string]$cfg.restart
    WaitSeconds = [int]$cfg.waitSeconds
    JobId       = [string]$cfg.jobId
}
if ($cfg.icon) { $arguments['Icon'] = [string]$cfg.icon }

& $worker @arguments
exit $LASTEXITCODE
