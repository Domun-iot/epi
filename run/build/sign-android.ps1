param([switch]$CreateKey, [string]$KeyDirectory = (Join-Path $env:USERPROFILE 'epi-keys'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$jdk = Join-Path $env:LOCALAPPDATA 'epi-dev/jdk-17/bin'
$sdk = Join-Path $env:LOCALAPPDATA 'epi-dev/android-sdk'
$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android build-tools missing' }
$key = Join-Path $KeyDirectory 'epi-upload.p12'
$credential = Join-Path $KeyDirectory 'epi-upload.password.xml'
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Android signing command failed: $LASTEXITCODE" } }
if (-not (Test-Path $key)) {
    if (-not $CreateKey) { throw 'No upload key. Use -CreateKey ONCE, only if no Play upload key already exists.' }
    if (Test-Path $credential) { throw 'Orphaned credential: restore the matching keystore first.' }
    New-Item -ItemType Directory -Force -Path $KeyDirectory | Out-Null
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)
    $secure = ConvertTo-SecureString $secret -AsPlainText -Force
    [pscredential]::new('epi-upload', $secure) | Export-Clixml -LiteralPath $credential
} elseif ($CreateKey) { Write-Host 'Reusing existing upload key.' }
# DPAPI: password file is usable only by this Windows user on this computer.
$stored = Import-Clixml -LiteralPath $credential
$previous = $env:EPI_SIGN_PASSWORD
$previousJavaHome = $env:JAVA_HOME
try {
    $env:JAVA_HOME = Split-Path $jdk -Parent
    $env:EPI_SIGN_PASSWORD = $stored.GetNetworkCredential().Password
    if (-not (Test-Path $key)) {
        & "$jdk/keytool.exe" -genkeypair -storetype PKCS12 -keystore $key -alias epi-upload -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Logisan, OU=Domun, O=Logisan, L=Val d Oust, C=FR' -storepass:env EPI_SIGN_PASSWORD -keypass:env EPI_SIGN_PASSWORD
        Check-Exit
    }
    $release = Join-Path $repo 'release/android'
    $apk = Join-Path $release 'epi-release-unsigned.apk'
    if (Test-Path $apk) {
        $aligned = Join-Path $release 'epi-release-aligned.apk'
        & "$($buildTools.FullName)/zipalign.exe" -f -P 16 4 $apk $aligned
        Check-Exit
        & "$($buildTools.FullName)/apksigner.bat" sign --ks $key --ks-key-alias epi-upload --ks-pass env:EPI_SIGN_PASSWORD --key-pass env:EPI_SIGN_PASSWORD --out "$release/epi-release.apk" $aligned
        Check-Exit
        & "$($buildTools.FullName)/apksigner.bat" verify --verbose --print-certs "$release/epi-release.apk"
        Check-Exit
        & "$($buildTools.FullName)/zipalign.exe" -c -P 16 4 "$release/epi-release.apk"
        Check-Exit
        Remove-Item -LiteralPath $aligned
    }
    $aab = Join-Path $release 'epi-play.aab'
    if (Test-Path $aab) {
        & "$jdk/jarsigner.exe" -keystore $key -storepass:env EPI_SIGN_PASSWORD -signedjar "$release/epi-play-signed.aab" $aab epi-upload
        Check-Exit
        & "$jdk/jarsigner.exe" -verify "$release/epi-play-signed.aab"
        Check-Exit
    }
    & "$jdk/keytool.exe" -exportcert -rfc -keystore $key -storepass:env EPI_SIGN_PASSWORD -alias epi-upload -file "$release/epi-upload-certificate.pem"
    Check-Exit
    Get-ChildItem $release -File | Where-Object { $_.Name -in @('epi-release.apk', 'epi-play-signed.aab') } | Get-FileHash -Algorithm SHA256 | Format-Table -AutoSize
} finally {
    $env:EPI_SIGN_PASSWORD = $previous
    $env:JAVA_HOME = $previousJavaHome
}
