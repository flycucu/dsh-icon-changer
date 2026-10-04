#Requires -Version 5.1
<#
    Detached worker for dsh-icon-changer.

    Started by the plugin while DeepSeek Harness is still running. It waits for
    the app to release its own .exe, then rewrites (or restores) the embedded
    icon with rcedit, verifies the result, records the outcome in the plugin
    state file, and optionally relaunches the app.

    Kept ASCII-only and BOM-safe: Windows PowerShell 5.1 mangles non-ASCII
    script files without a BOM.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('apply', 'restore')][string]$Op,
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Icon,
    [Parameter(Mandatory = $true)][string]$State,
    [Parameter(Mandatory = $true)][string]$Log,
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [Parameter(Mandatory = $true)][string]$Rcedit,
    [string]$Restart = '0',
    [int]$WaitSeconds = 1800,
    [string]$JobId = ''
)

$ErrorActionPreference = 'Stop'

# Console text for the window the user is looking at (see console-messages.ps1).
$messagesHelper = Join-Path $PSScriptRoot 'console-messages.ps1'
if (Test-Path -LiteralPath $messagesHelper) { . $messagesHelper }
if (-not (Get-Command Get-DshText -ErrorAction SilentlyContinue)) {
    function Get-DshText { param([int]$Index, [string]$Fallback) return $Fallback }
    function Write-DshText { param([string]$Text) try { Write-Host $Text } catch { } }
}

function Write-Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
    try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch { }
}

function Get-IconHash([string]$path) {
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
        if (-not $icon) { return $null }
        $bmp = $icon.ToBitmap()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        # Rewind before hashing: Get-FileHash -InputStream reads from the CURRENT
        # position, so without this every file hashes as the empty stream and the
        # before/after comparison below can never see a change.
        $ms.Position = 0
        $hash = (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash
        $icon.Dispose(); $bmp.Dispose(); $ms.Dispose()
        return $hash
    } catch {
        Write-Log "hash failed: $($_.Exception.Message)"
        return $null
    }
}

function Update-State([hashtable]$patch) {
    try {
        $doc = @{}
        if (Test-Path $State) {
            $raw = Get-Content $State -Raw -Encoding UTF8
            if ($raw.Trim()) {
                $obj = $raw | ConvertFrom-Json
                foreach ($p in $obj.PSObject.Properties) { $doc[$p.Name] = $p.Value }
            }
        }
        foreach ($k in $patch.Keys) { $doc[$k] = $patch[$k] }
        $json = $doc | ConvertTo-Json -Depth 8
        # Write UTF-8 WITHOUT a BOM: the host half parses this file with JSON.parse,
        # which rejects a leading U+FEFF - and readState() swallows that error, so a
        # BOM here makes the entire plugin state look empty to the settings card.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($State, $json, $utf8NoBom)
    } catch {
        Write-Log "state write failed: $($_.Exception.Message)"
    }
}

function Stop-With([string]$message, [bool]$ok) {
    Write-Log "RESULT ok=$ok :: $message"
    if ($ok) {
        $closing = Get-DshText -Index 4 -Fallback 'Done - this window closes by itself now.'
    } else {
        $closing = Get-DshText -Index 5 -Fallback 'Failed - see helper.log. This window closes by itself now.'
    }
    Write-DshText -Text ''
    Write-DshText -Text ('  ' + $message)
    Write-DshText -Text ('  ' + $closing)
    Update-State @{
        pending    = $null
        lastResult = @{
            ok      = $ok
            op      = $Op
            at      = (Get-Date).ToString('o')
            message = $message
        }
    }
    exit ([int]( -not $ok ))
}

Write-Log "start op=$Op exe=$Exe icon=$Icon restart=$Restart"

if (-not (Test-Path $Exe)) { Stop-With "exe not found: $Exe" $false }
if ($Op -eq 'apply' -and -not (Test-Path $Icon)) { Stop-With "icon not found: $Icon" $false }
if (-not (Test-Path $Rcedit)) { Stop-With "rcedit not found: $Rcedit" $false }

# --- 1. wait for the app to let go of its own executable ------------------- #
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$free = $false
while ((Get-Date) -lt $deadline) {
    try {
        $fs = [System.IO.File]::Open($Exe, 'Open', 'ReadWrite', 'None')
        $fs.Close()
        $free = $true
        break
    } catch {
        Start-Sleep -Milliseconds 700
    }
}
if (-not $free) {
    Stop-With "timed out waiting for $WaitSeconds s; the app is still running, nothing was changed" $false
}
Write-Log 'exe is writable, proceeding'

# --- 1b. has a newer request taken over? ----------------------------------- #
# More than one worker can be waiting for the app to exit (a queued job plus the
# startup retry of an older one). Whichever wakes up must check that the queue it
# was created for is still the current one, otherwise two workers would rewrite the
# same exe and the icon would be a coin toss. Exit quietly, without touching state:
# the newer worker owns both the exe and the queue record.
if ($JobId -and (Test-Path -LiteralPath $State)) {
    try {
        $latest = (Get-Content -LiteralPath $State -Raw -Encoding UTF8 | ConvertFrom-Json).pending
        $latestId = if ($latest) { [string]$latest.queuedAt } else { '' }
        if ($latestId -ne $JobId) {
            Write-Log "SUPERSEDED: this job is $JobId but the queue now holds '$latestId'; nothing was changed"
            Write-DshText -Text ''
            Write-DshText -Text ('  ' + (Get-DshText -Index 6 -Fallback 'A newer request took over; this one stopped without changing anything.'))
            Write-DshText -Text ('  ' + (Get-DshText -Index 4 -Fallback 'Done - this window closes by itself now.'))
            exit 0
        }
    } catch {
        Write-Log "superseded check failed (continuing): $($_.Exception.Message)"
    }
}

# --- 2. one-time backup of the pristine executable ------------------------- #
$backup = Join-Path $BackupDir 'DeepSeek Harness.exe.orig'
if ($Op -eq 'apply' -and -not (Test-Path $backup)) {
    try {
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        Copy-Item $Exe $backup -Force
        Write-Log "backed up original exe ($((Get-Item $backup).Length) bytes)"
    } catch {
        Stop-With "backup failed: $($_.Exception.Message)" $false
    }
}

$before = Get-IconHash $Exe
$want = if ($Icon) { Get-IconHash $Icon } else { $null }
Write-Log "icon hash before: $before (requested: $want)"

# --- 3. do the work -------------------------------------------------------- #
Write-DshText -Text ('  ' + (Get-DshText -Index 2 -Fallback 'Writing the new icon...'))
if ($Op -eq 'apply') {
    # A native command writing to stderr becomes a terminating ErrorRecord while
    # $ErrorActionPreference is 'Stop', which would abort this script before it
    # could record a result. Relax it for the call only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $Rcedit $Exe --set-icon $Icon 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($out) { Write-Log ("rcedit: " + (($out | ForEach-Object { "$_" }) -join ' ')) }
    if ($code -ne 0) { Stop-With "rcedit exited with code $code" $false }
} else {
    if (-not (Test-Path $backup)) { Stop-With 'no backup to restore from' $false }
    try {
        Copy-Item $backup $Exe -Force
        Write-Log 'exe restored from backup'
    } catch {
        Stop-With "restore failed: $($_.Exception.Message)" $false
    }
}

# --- 4. verify ------------------------------------------------------------- #
Start-Sleep -Milliseconds 400
$after = Get-IconHash $Exe
Write-Log "icon hash after: $after"

if ($Op -eq 'apply') {
    if (-not $after) { Stop-With 'could not read the icon back after writing' $false }
    if ($after -eq $before) {
        # No change means rcedit failed to write anything. Unless the exe already
        # carries exactly the requested icon, put the original back and report it.
        if ($want -and $after -eq $want) {
            Write-Log 'exe already carries the requested icon, nothing to do'
        } else {
            if (Test-Path $backup) { Copy-Item $backup $Exe -Force }
            Stop-With 'icon hash unchanged after rcedit ran; original exe restored' $false
        }
    }
} else {
    if ($after -eq $before) {
        Stop-With 'restore produced no change (already the original icon?)' $true
    }
}

# Rewriting the exe is not enough on its own: Explorer keeps serving the cached
# bitmap, so the desktop and taskbar keep showing the old icon until the shell is
# made to re-read it. ie4uinit is the cheap half, and pendingExplorer is the
# definitive half - the host's reconcilePendingExplorer() restarts Explorer right
# after the app comes back up.
Update-State @{
    applied         = @{ op = $Op; icon = $Icon; at = (Get-Date).ToString('o'); hash = $after }
    pendingExplorer = $true
}

# $env:SystemRoot instead of a hardcoded C:\Windows: Windows can live elsewhere.
$ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path -LiteralPath $ie4uinit) {
    try {
        & $ie4uinit -show 2>$null | Out-Null
        Write-Log 'ie4uinit -show ran (icon cache refresh requested)'
    } catch {
        Write-Log "ie4uinit failed: $($_.Exception.Message)"
    }
}

# --- 5. relaunch ----------------------------------------------------------- #
# The app may well be back already (a supervisor or the user started it while we
# were rewriting). Starting a second copy would be worse than not restarting.
if ($Restart -eq '1') {
    Write-DshText -Text ('  ' + (Get-DshText -Index 3 -Fallback 'Icon written, restarting the app...'))
    Start-Sleep -Milliseconds 300
    $imageName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
    $running = Get-Process -Name $imageName -ErrorAction SilentlyContinue
    if ($running) {
        Write-Log "app is already running ($($running.Count) process(es)), skipping relaunch"
    } else {
        # Launch the app through WMI, NOT as a child of this script.
        #
        # A plain Start-Process hands this console to the app: the window then stays
        # open for as long as the app lives (the app's stdout even lands in it), and
        # closing that window would send CTRL_CLOSE to the freshly started app. A
        # process created by wmiprvse inherits no console at all, so this window can
        # close the moment this script ends and nothing can kill the app by closing it.
        $relaunched = $false
        try {
            $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
                CommandLine      = ('"' + $Exe + '"')
                CurrentDirectory = (Split-Path -Parent $Exe)
            }
            if ($created.ReturnValue -eq 0) {
                Write-Log ("app relaunched without a console (pid={0})" -f $created.ProcessId)
                $relaunched = $true
            } else {
                Write-Log ("Win32_Process.Create returned {0}" -f $created.ReturnValue)
            }
        } catch {
            Write-Log "console-free relaunch failed: $($_.Exception.Message)"
        }
        if (-not $relaunched) {
            try {
                Start-Process -FilePath $Exe
                Write-Log 'app relaunched (fallback: it may inherit this console)'
            } catch {
                Write-Log "relaunch failed: $($_.Exception.Message)"
            }
        }
    }
}

Stop-With "done ($Op)" $true
