Set-StrictMode -Version Latest

function Assert-NivelSetupHookLog {
    param([Parameter(Mandatory)][string]$Text)
    # Setup can return zero even after showing "Install Partially Succeeded".
    # Require a successful hook and installation, not just a successful process.
    if ($Text -notmatch 'Running --veloapp-install hook' -or
        $Text -notmatch 'Hook executed successfully \(took [0-9.]+ms\)' -or
        $Text -notmatch 'Installation completed successfully!' -or
        $Text -match 'Hook exited with non-zero|Failed to start hook|Process timed out|Error waiting for process|Was unable to wait for hook|Installation failed!') {
        throw 'Setup did not complete its install hook successfully.'
    }
}

function Test-NivelWindowsSetup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SetupExe,
        [Parameter(Mandatory)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version,
        [Parameter(Mandatory)][ValidatePattern('^NivelOmega(?:\.InstallSmoke|\.Development)?$')][string]$PackageId,
        [Parameter(Mandatory)][string]$OutputDirectory,
        [switch]$RequireSideBySideRuntime
    )
    # Setup writes per-user uninstall entries even with --installto. Never run
    # this on a developer's PC or the persistent Unity runner.
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        throw 'Setup checks require an ephemeral GitHub-hosted Windows runner.'
    }
    $setup = [IO.Path]::GetFullPath($SetupExe)
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Setup executable is missing.' }
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nivel-install-check-' + [Guid]::NewGuid().ToString('N'))
    $install = Join-Path $testRoot '설치 경로'
    $report = [Collections.Generic.List[object]]::new()
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    try {
        foreach ($phase in @('fresh', 'reinstall')) {
            $log = Join-Path $output ($phase + '.log')
            if (Test-Path -LiteralPath $log) { throw 'Setup log output already exists.' }
            $bundle = Join-Path $testRoot ('cold bundle ' + $phase)
            $start = [Diagnostics.ProcessStartInfo]::new($setup)
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            foreach ($argument in @('--silent', '--verbose', '--installto', $install, '--log', $log)) {
                $start.ArgumentList.Add($argument)
            }
            $start.Environment['DOTNET_BUNDLE_EXTRACT_BASE_DIR'] = $bundle
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $process = [Diagnostics.Process]::Start($start)
            try {
                if (-not $process.WaitForExit(180000)) {
                    $process.Kill($true)
                    $process.WaitForExit()
                    throw 'Setup check timed out.'
                }
                if ($process.ExitCode -ne 0) { throw "Setup exited with code $($process.ExitCode)." }
            } finally { $process.Dispose() }
            $text = Get-Content -LiteralPath $log -Raw
            Assert-NivelSetupHookLog $text
            $manifest = Join-Path $install 'current/sq.version'
            if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'Installed manifest is missing.' }
            [xml]$metadata = Get-Content -LiteralPath $manifest -Raw
            if ([string]$metadata.package.metadata.id -ne $PackageId -or
                [string]$metadata.package.metadata.version -ne $Version -or
                [string]$metadata.package.metadata.mainExe -ne 'NivelOmega.Launcher.exe') {
                throw 'Installed package identity or main executable is incorrect.'
            }
            $launcher = Join-Path $install 'current/NivelOmega.Launcher.exe'
            if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Installed launcher is missing.' }
            if ($RequireSideBySideRuntime) {
                foreach ($native in @('coreclr.dll', 'clrjit.dll')) {
                    if (-not (Test-Path -LiteralPath (Join-Path $install ('current/' + $native)) -PathType Leaf)) {
                        throw "The native runtime must ship beside the launcher: $native"
                    }
                }
                if (Test-Path -LiteralPath $bundle) { throw 'Install hook unexpectedly extracted a native runtime bundle.' }
            }
            $hookMs = [regex]::Match($text, 'Hook executed successfully \(took ([0-9.]+)ms\)').Groups[1].Value
            $report.Add(@{ phase = $phase; hookMilliseconds = [double]$hookMs; setupSeconds = $timer.Elapsed.TotalSeconds; result = 'passed' })
            Write-Host "$phase Setup and install hook passed ($hookMs ms)."
        }
    } catch {
        $report.Add(@{ phase = $phase; result = 'failed'; error = $_.Exception.Message })
        throw
    } finally {
        ConvertTo-Json -InputObject $report.ToArray() -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'results.json') -Encoding utf8
        # Only the exact generated temporary tree is removed; the VM discards
        # the temporary package's registry/shortcut entries when the job ends.
        if ([IO.Path]::GetFileName($testRoot) -notmatch '^nivel-install-check-[a-f0-9]{32}$' -or
            [IO.Path]::GetDirectoryName($testRoot).TrimEnd('\', '/') -ne
            [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')) {
            throw 'Setup test cleanup path is invalid.'
        }
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
}
