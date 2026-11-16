[CmdletBinding()]
param(
    [Parameter()]
    [switch]$BypassAdmin
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-Spotifast {
    param (
        [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    
    $spicetifyArgs = @()
    if ($BypassAdmin) {
        $spicetifyArgs += "--bypass-admin"
    }
    $spicetifyArgs += $Arguments
    
    & spotifast $spicetifyArgs
    return $LASTEXITCODE
}

function Invoke-SpotifastWithOutput {
    param (
        [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    
    $spicetifyArgs = @()
    if ($BypassAdmin) {
        $spicetifyArgs += "--bypass-admin"
    }
    $spicetifyArgs += $Arguments
    
    $output = (& spotifast $spicetifyArgs 2>&1 | Out-String).Trim()
    return @{
        Output = $output
        ExitCode = $LASTEXITCODE
    }
}

Write-Host -Object 'Setting up...' -ForegroundColor 'Cyan'

if (-not (Get-Command -Name 'spotifast' -ErrorAction 'SilentlyContinue')) {
    Write-Host -Object 'Spotifast not found.' -ForegroundColor 'Yellow'
    Write-Host -Object 'Installing it for you...' -ForegroundColor 'Cyan'
    $Parameters = @{
        Uri             = 'https://raw.githubusercontent.com/Maxodus126/Spotifast/main/install.ps1'
        UseBasicParsing = $true
    }
    Invoke-WebRequest @Parameters | Invoke-Expression
}

try {
    $result = Invoke-SpotifastWithOutput "path" "userdata"
    if ($result.ExitCode -ne 0) {
        Write-Host -Object "Error from Spicetify:" -ForegroundColor 'Red'
        Write-Host -Object $result.Output -ForegroundColor 'Red'
        return
    }
    $spiceUserDataPath = $result.Output
} catch {
    Write-Host -Object "Error running Spicetify:" -ForegroundColor 'Red'
    Write-Host -Object $_.Exception.Message.Trim() -ForegroundColor 'Red'
    return
}

if (-not (Test-Path -Path $spiceUserDataPath -PathType 'Container' -ErrorAction 'SilentlyContinue')) {
    $spiceUserDataPath = "$env:APPDATA\spicetify"
}
$marketAppPath = "$spiceUserDataPath\CustomApps\marketplace"
$marketThemePath = "$spiceUserDataPath\Themes\marketplace"

$isThemeInstalled = $(
    Invoke-Spotifast "path" "-s" | Out-Null
    -not $LASTEXITCODE
)
$currentTheme = (Invoke-SpotifastWithOutput "config" "current_theme").Output
$setTheme = $true

Write-Host -Object 'Removing and creating Marketplace folders...' -ForegroundColor 'Cyan'
try {
    $result = Invoke-SpotifastWithOutput "path" "userdata"
    if ($result.ExitCode -ne 0) {
        Write-Host -Object "Error: Failed to get Spicetify path. Details:" -ForegroundColor 'Red'
        Write-Host -Object $result.Output -ForegroundColor 'Red'
        return
    }

    Remove-Item -Path $marketAppPath, $marketThemePath -Recurse -Force -ErrorAction 'SilentlyContinue' | Out-Null
    if (-not (New-Item -Path $marketAppPath, $marketThemePath -ItemType 'Directory' -Force -ErrorAction 'Stop')) {
        Write-Host -Object "Error: Failed to create Marketplace directories." -ForegroundColor 'Red'
        return
    }
} catch {
    Write-Host -Object "Error: $($_.Exception.Message.Trim())" -ForegroundColor 'Red'
    return
}

Write-Host -Object 'Downloading Marketplace...' -ForegroundColor 'Cyan'
$marketArchivePath = "$marketAppPath\marketplace.zip"
$unpackTemp = "$marketAppPath\_unpack"
$Parameters = @{
  Uri             = 'https://github.com/Maxodus126/spotifast-marketplace/releases/latest/download/marketplace.zip'
  UseBasicParsing = $true
  OutFile         = $marketArchivePath
}
Invoke-WebRequest @Parameters

Write-Host -Object 'Unzipping and installing...' -ForegroundColor 'Cyan'
Expand-Archive -Path $marketArchivePath -DestinationPath $unpackTemp -Force
# Release zip contains a single *-dist folder; find it instead of hardcoding the name
$unpackedFolderPath = (Get-ChildItem -Path $unpackTemp -Directory | Select-Object -First 1).FullName
if (-not $unpackedFolderPath) { throw "Marketplace archive has no top-level folder" }
Move-Item -Path "$unpackedFolderPath\*" -Destination $marketAppPath -Force
Remove-Item -Path $marketArchivePath, $unpackTemp -Recurse -Force
Invoke-Spotifast "config" "custom_apps" "spicetify-marketplace-" "-q"
Invoke-Spotifast "config" "custom_apps" "marketplace"
Invoke-Spotifast "config" "inject_css" "1" "replace_colors" "1"

Write-Host -Object 'Downloading placeholder theme...' -ForegroundColor 'Cyan'
$Parameters = @{
  Uri             = 'https://raw.githubusercontent.com/spicetify/marketplace/main/resources/color.ini'
  UseBasicParsing = $true
  OutFile         = "$marketThemePath\color.ini"
}
Invoke-WebRequest @Parameters

Write-Host -Object 'Applying...' -ForegroundColor 'Cyan'
if ($isThemeInstalled -and ($currentTheme -ne 'marketplace')) {
    $Host.UI.RawUI.Flushinputbuffer()
    $themeChoices = [System.Management.Automation.Host.ChoiceDescription[]] @(
        (New-Object System.Management.Automation.Host.ChoiceDescription '&Yes', 'Replace the local theme.'),
        (New-Object System.Management.Automation.Host.ChoiceDescription '&No',  'Keep the local theme.')
    )
    $choice = $Host.UI.PromptForChoice(
        'Local theme found',
        'Do you want to replace it with a placeholder to install themes from the Marketplace?',
        $themeChoices,
        0
    )
    if ($choice -eq 1) { $setTheme = $false }
}
if ($setTheme) {
    Invoke-Spotifast "config" "current_theme" "marketplace"
}
Invoke-Spotifast "backup"
Invoke-Spotifast "apply"

Write-Host -Object 'Done!' -ForegroundColor 'Green'
Write-Host -Object 'If nothing has happened, check the messages above for errors'