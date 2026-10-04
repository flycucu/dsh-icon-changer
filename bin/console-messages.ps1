#Requires -Version 5.1
<#
    Console text for the visible worker window, shared by run-worker.ps1 and
    apply-icon.ps1 (dot-source this file).

    The scripts themselves stay ASCII-only on purpose: Windows PowerShell 5.1 parses
    a BOM-less script as ANSI and would mangle any non-ASCII literal. The Chinese
    strings therefore live in messages.txt and are read with an explicit -Encoding
    UTF8, which decodes that file correctly whether or not it has a BOM.

    Line order in messages.txt (0-based, that is the index used below):
      0  changing the icon now, do not close this window
      1  waiting for the app to exit
      2  writing the new icon
      3  icon written, restarting the app
      4  done, this window closes on its own
      5  something failed, see helper.log
#>
$script:DshMessageFile = Join-Path $PSScriptRoot 'messages.txt'
$script:DshMessages = @()
if (Test-Path -LiteralPath $script:DshMessageFile) {
    try {
        $script:DshMessages = @(Get-Content -LiteralPath $script:DshMessageFile -Encoding UTF8)
    } catch {
        $script:DshMessages = @()
    }
}

# Returns the localized line, or the ASCII fallback when the file is missing.
function Get-DshText {
    param(
        [Parameter(Mandatory = $true)][int]$Index,
        [AllowEmptyString()][string]$Fallback = ''
    )
    if ($Index -ge 0 -and $Index -lt $script:DshMessages.Count) {
        $text = [string]$script:DshMessages[$Index]
        if ($text -and $text.Trim()) { return $text.Trim() }
    }
    return $Fallback
}

# AllowEmptyString matters: the worker prints blank spacer lines, and a Mandatory
# parameter would refuse the empty string and (with ErrorActionPreference=Stop) kill
# the whole job - which is exactly what happened the first time this was written.
function Write-DshText {
    param([AllowEmptyString()][string]$Text = '')
    try { Write-Host $Text } catch { }
}

function Set-DshWindowTitle {
    param([AllowEmptyString()][string]$Text = '')
    try { if ($Text) { $Host.UI.RawUI.WindowTitle = $Text } } catch { }
}
