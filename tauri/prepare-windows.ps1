param([switch]$AndroidOnly, [switch]$DesktopOnly, [switch]$NodeOnly, [switch]$AcceptAndroidLicenses)

$ErrorActionPreference = 'Stop'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 requis.' }
$tools = Join-Path $env:LOCALAPPDATA 'epi-dev'
$sdk = Join-Path $tools 'android-sdk'
$jdk = Join-Path $tools 'jdk-17'
$node = Join-Path $tools 'node'
$env:Path = "$node;$env:USERPROFILE\.cargo\bin;$env:Path"

function Invoke-Checked($program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program a echoue (code $LASTEXITCODE)." }
}

function Install-Archive($url, $destination, $folder, $marker) {
    if (Test-Path (Join-Path $destination $marker)) { return }
    $stage = Join-Path $tools ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        $archive = Join-Path $stage 'download.zip'
        Invoke-Checked curl.exe @('-fsSL', '--retry', '3', '-o', $archive, $url)
        Invoke-Checked tar.exe @('-xf', $archive, '-C', $stage)
        $source = Get-ChildItem -LiteralPath $stage -Directory -Filter $folder | Select-Object -First 1
        if (!$source -or !(Test-Path (Join-Path $source.FullName $marker))) {
            throw "Archive inattendue pour $destination."
        }
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Move-Item -LiteralPath $source.FullName -Destination $destination
    } finally {
        # $stage est un dossier temporaire enfant direct de $tools, cree ci-dessus.
        $resolved = (Resolve-Path -LiteralPath $stage).ProviderPath
        if ((Split-Path $resolved) -eq $tools) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}

$nodeReady = $false
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
    & node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
    $nodeReady = $LASTEXITCODE -eq 0
}
if (!$nodeReady) {
    $version = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object {
        $_.version -like 'v22.*' -and $_.lts -and $_.files -contains 'win-x64-zip'
    } | Select-Object -First 1).version
    if (!$version) { throw 'Version Node.js LTS introuvable.' }
    Install-Archive "https://nodejs.org/dist/$version/node-$version-win-x64.zip" $node 'node-*' 'node.exe'
}
if ($NodeOnly) { exit 0 }

if (!(Get-Command rustup.exe -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    $installer = Join-Path $tools 'rustup-init.exe'
    Invoke-Checked curl.exe @('-fsSL', '-o', $installer, 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe')
    Invoke-Checked $installer @('-y', '--default-toolchain', 'stable-x86_64-pc-windows-msvc')
}

$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvc = if (Test-Path $vswhere) {
    & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (!$msvc) {
    Invoke-Checked winget.exe @('install', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '--exact',
        '--accept-package-agreements', '--accept-source-agreements', '--override',
        '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
}
if (!$AndroidOnly) {
    $webview = Get-ChildItem -Path "$([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe",
        "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue
    if (!$webview) {
        Invoke-Checked winget.exe @('install', '--id', 'Microsoft.EdgeWebView2Runtime', '--exact',
            '--accept-package-agreements', '--accept-source-agreements')
    }
}

if (!$DesktopOnly) {
    $developerMode = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
    if ($developerMode -ne 1) {
        Write-Host 'Active le Mode developpeur Windows pour autoriser les liens symboliques Tauri.'
        if ((Read-Host 'Ouvrir les parametres Windows ? [o/N]') -match '^(o|oui|y|yes)$') {
            Start-Process 'ms-settings:developers'
            Read-Host 'Active le Mode developpeur, puis appuie sur Entree' | Out-Null
        }
        $developerMode = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
        if ($developerMode -ne 1) { throw 'Mode developpeur desactive. Active-le, puis relance run/prep/android.bat.' }
    }
    Write-Host 'Installation du JDK et du SDK Android dans le profil utilisateur...'
    Install-Archive 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' $jdk 'jdk-*' 'bin\java.exe'
    $cmdline = Join-Path $sdk 'cmdline-tools\latest'
    Install-Archive 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' $cmdline 'cmdline-tools' 'bin\sdkmanager.bat'
    $env:JAVA_HOME = $jdk
    $env:ANDROID_HOME = $sdk
    $manager = Join-Path $cmdline 'bin\sdkmanager.bat'
    $packages = @('--install', 'platform-tools', 'platforms;android-34', 'platforms;android-37.0', 'build-tools;36.0.0', 'ndk;28.2.13676358')
    if ($AcceptAndroidLicenses) {
        1..20 | ForEach-Object { 'y' } | & $manager @packages
        if ($LASTEXITCODE -ne 0) { throw 'Installation des paquets Android impossible.' }
    } else {
        Invoke-Checked $manager $packages
    }
    foreach ($installed in 'platform-tools\adb.exe', 'platforms\android-34\android.jar', 'platforms\android-37.0\android.jar',
            'build-tools\36.0.0\apksigner.bat', 'ndk\28.2.13676358\source.properties') {
        if (!(Test-Path (Join-Path $sdk $installed))) {
            throw "Paquet Android manquant : $installed. Relance prepare et accepte les licences requises."
        }
    }
    Invoke-Checked rustup.exe @('target', 'add', 'aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android')
}
Push-Location $PSScriptRoot
try {
    if (!(Test-Path 'node_modules/@tauri-apps/cli/tauri.js')) { Invoke-Checked npm.cmd @('ci') }
} finally {
    Pop-Location
}
