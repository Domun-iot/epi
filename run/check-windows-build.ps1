param([ValidateSet('desktop', 'cli')][string]$Target = 'desktop')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$inputs = @('shared')
if ($Target -eq 'cli') {
    $exe = Get-Item -LiteralPath (Join-Path $root 'release/cli/windows/epi-cli.exe')
    $inputs += @(
        'cli/package.json'
        'cli/package-lock.json'
        'cli/scan.cs'
        'run/build-cli.bat'
    )
    $inputs += Get-ChildItem -LiteralPath (Join-Path $root 'cli') -Filter '*.cjs' -File |
        Where-Object Name -NotLike '*.test.cjs' | ForEach-Object { 'cli/' + $_.Name }
} else {
    $exe = Get-Item -LiteralPath (Join-Path $root 'release/windows/epi.exe')
    $inputs += @(
        'tauri/index.html'
        'tauri/package.json'
        'tauri/package-lock.json'
        'tauri/vite.config.js'
        'tauri/desktop.mjs'
        'tauri/src'
        'tauri/domain'
        'tauri/src-tauri/Cargo.toml'
        'tauri/src-tauri/Cargo.lock'
        'tauri/src-tauri/build.rs'
        'tauri/src-tauri/tauri.conf.json'
        'tauri/src-tauri/tauri.windows.conf.json'
        'tauri/src-tauri/capabilities'
        'tauri/src-tauri/icons'
        'tauri/src-tauri/src'
        'run/build-windows.bat'
    )
}
foreach ($inputPath in $inputs) {
    $path = Join-Path $root $inputPath
    if (!(Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path
    if ($item.LastWriteTimeUtc -gt $exe.LastWriteTimeUtc) { exit 1 }
    if ($item.PSIsContainer) {
        $newer = Get-ChildItem -LiteralPath $path -Recurse -Force |
            Where-Object LastWriteTimeUtc -gt $exe.LastWriteTimeUtc | Select-Object -First 1
        if ($newer) { exit 1 }
    }
}
exit 0
