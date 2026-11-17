$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$sandbox = Join-Path $temporaryRoot ('epi-esbuild-test-' + [guid]::NewGuid().ToString())
$checkout = Join-Path $sandbox (([char]0xE9).ToString() + 'PI with spaces')
$scriptDirectory = Join-Path $checkout 'scripts'
$projectExe = Join-Path $checkout 'tauri\node_modules\@esbuild\win32-x64\esbuild.exe'
$otherExe = Join-Path $sandbox 'other project\esbuild.exe'
$processes = @()

try {
    foreach ($directory in @($scriptDirectory, (Split-Path $projectExe), (Split-Path $otherExe))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $helper = Join-Path $scriptDirectory 'stop-web-esbuild.ps1'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop-web-esbuild.ps1') -Destination $helper

    # No executable installed and no matching process: nothing to stop.
    & $helper
    foreach ($executable in @($projectExe, $otherExe)) {
        # A renamed Node process stays alive without needing the esbuild protocol.
        Copy-Item -LiteralPath $node -Destination $executable
        $child = Start-Process -FilePath $executable -ArgumentList '-e "setInterval(() => {}, 1000)"' -WindowStyle Hidden -PassThru
        $processes += $child
        if ($child.WaitForExit(300)) { throw "Test process failed to start: $executable" }
    }

    & $helper
    if (!$processes[0].WaitForExit(1000)) { throw 'Project esbuild was not stopped.' }
    $processes[1].Refresh()
    if ($processes[1].HasExited) { throw 'An esbuild from another project was stopped.' }

    # Repeating the cleanup is harmless while the unrelated process remains alive.
    & $helper
    $processes[1].Refresh()
    if ($processes[1].HasExited) { throw 'Repeated cleanup stopped another project.' }
    Write-Host 'Project esbuild stopped; unrelated esbuild preserved; repeated cleanup passed.'
} finally {
    foreach ($child in $processes) {
        if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }
        $child.Dispose()
    }
    # Only remove the unique temporary directory created by this test.
    $resolved = [System.IO.Path]::GetFullPath($sandbox)
    if ((Split-Path $resolved) -eq $temporaryRoot.TrimEnd('\') -and
        (Split-Path $resolved -Leaf) -like 'epi-esbuild-test-*' -and
        (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
