$ErrorActionPreference = 'Stop'
$executable = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tauri\node_modules\@esbuild\win32-x64\esbuild.exe'))

# Match the full path so builds in other repositories keep their own esbuild.
$processes = @(Get-Process -Name esbuild -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -ieq $executable })
foreach ($process in $processes) {
    Write-Host "Stopping project esbuild (PID $($process.Id)): $executable"
    try {
        $process.Kill()
    } catch {
        # The service may have exited between enumeration and termination.
        if (!$process.HasExited) { throw }
    }
    if (!$process.WaitForExit(5000)) {
        throw "Timed out waiting for project esbuild (PID $($process.Id)) to exit."
    }
}
