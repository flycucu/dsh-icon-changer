#Requires -Version 5.1
<#
    Launches a command line through the WMI service instead of as our own child.

    Why this exists: DeepSeek Harness runs inside a job object that takes its
    children down with it, and the icon worker MUST outlive the app - the running
    .exe is locked by Windows and can only be rewritten once the app is gone. A
    process created by Win32_Process.Create belongs to wmiprvse.exe, so it is not
    part of the app's job object and survives the kill.

    -CommandFile holds the exact command line as one line of text: keeping it in a
    file sidesteps having to quote a whole command line through this script's own
    command line (and through PowerShell's parser twice).
    -ResultFile receives a small JSON report so the caller can tell success from a
    silent failure.

    ASCII-only on purpose: Windows PowerShell 5.1 mangles non-ASCII script files
    that have no BOM.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CommandFile,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [string]$Log
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$message) {
    if (-not $Log) { return }
    try {
        Add-Content -LiteralPath $Log -Value ("[{0}] [wmi-spawn] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8
    } catch { }
}

function Write-Result([bool]$ok, [int]$processId, [string]$message) {
    try {
        $json = @{ ok = $ok; pid = $processId; message = $message } | ConvertTo-Json -Compress
        # Write UTF-8 WITHOUT a BOM on purpose: the caller parses this as JSON, and
        # Set-Content -Encoding UTF8 on PowerShell 5.1 would prepend EF BB BF, which
        # makes JSON.parse fail and looks exactly like "the spawner said nothing".
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($ResultFile, $json, $utf8NoBom)
    } catch { }
}

if (-not (Test-Path -LiteralPath $CommandFile)) {
    Write-Log "command file missing: $CommandFile"
    Write-Result $false 0 'command-file-missing'
    exit 2
}

$commandLine = (Get-Content -LiteralPath $CommandFile -Raw -Encoding UTF8).Trim()
if (-not $commandLine) {
    Write-Log 'command file is empty'
    Write-Result $false 0 'command-file-empty'
    exit 3
}

try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
    if ($created.ReturnValue -eq 0) {
        Write-Log "created process pid=$($created.ProcessId)"
        Write-Result $true ([int]$created.ProcessId) 'created'
        exit 0
    }
    Write-Log "Win32_Process.Create failed: ReturnValue=$($created.ReturnValue)"
    Write-Result $false 0 ("Win32_Process.Create ReturnValue=" + $created.ReturnValue)
    exit 1
} catch {
    Write-Log "Win32_Process.Create threw: $($_.Exception.Message)"
    Write-Result $false 0 $_.Exception.Message
    exit 1
}
