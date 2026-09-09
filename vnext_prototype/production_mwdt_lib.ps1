<##
    Small, side-effect-free helpers shared by run_production_mwdt.ps1 and its
    deterministic tests.  Reset lines are counted twice on purpose:
    physical log lines (raw) and reset events after identity-based deduplication.
##>

function Get-ProductionSha256 {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-ProductionResetRecord {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Line)

    $pattern = '^\[LasecSimul\]\[ESP32 reset\] count=(\d+) mask=(0x[0-9a-fA-F]+) ' +
               'cause0=(\d+) cause1=(\d+) pc0=(0x[0-9a-fA-F]+) pc1=(0x[0-9a-fA-F]+) ' +
               'wdt0_enabled=(\d+) wdt1_enabled=(\d+) network=(\S+) expected=(\S+) ' +
               'source=(\S+) boot_epoch=(\d+) pid=(\d+)'
    $m = [regex]::Match($Line, $pattern)
    if (-not $m.Success) { return $null }

    $record = [pscustomobject]@{
        line       = $Line
        count      = $m.Groups[1].Value
        mask       = $m.Groups[2].Value
        cause0     = $m.Groups[3].Value
        cause1     = $m.Groups[4].Value
        pc0        = $m.Groups[5].Value
        pc1        = $m.Groups[6].Value
        wdt0       = $m.Groups[7].Value
        wdt1       = $m.Groups[8].Value
        network    = $m.Groups[9].Value
        expected   = $m.Groups[10].Value
        source     = $m.Groups[11].Value
        boot_epoch = $m.Groups[12].Value
        pid        = $m.Groups[13].Value
    }
    # Include all identity fields requested by the E130 correction.  The two
    # PCs are retained because reset lines can carry distinct CPU snapshots.
    $record | Add-Member -NotePropertyName key -NotePropertyValue (
        "$($record.pid)|$($record.boot_epoch)|$($record.count)|$($record.mask)|" +
        "$($record.pc0)|$($record.pc1)|$($record.source)")
    return $record
}

function Get-ProductionResetStatistics {
    param([AllowEmptyCollection()][string[]]$Lines)

    $records = @()
    foreach ($line in @($Lines)) {
        if ([string]::IsNullOrWhiteSpace([string]$line)) { continue }
        $record = Get-ProductionResetRecord -Line ([string]$line)
        if ($null -ne $record) { $records += $record }
    }

    $unique = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($record in $records) {
        if (-not $unique.ContainsKey($record.key)) { $unique[$record.key] = $record }
    }
    $uniqueRecords = @($unique.Values)
    $unexpected = @($uniqueRecords | Where-Object {
        -not ($_.expected -eq 'no' -and $_.source -eq 'OTHER' -and $_.count -eq '1') -and
        -not ($_.expected -eq 'app-cpu-startup')
    })

    return [pscustomobject]@{
        rawLines         = $records.Count
        deduplicated     = $uniqueRecords.Count
        records          = $records
        uniqueRecords    = $uniqueRecords
        unexpected       = $unexpected
        unexpectedCount  = $unexpected.Count
    }
}

function Convert-ProductionCimDateTime {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value }
    try { return [Management.ManagementDateTimeConverter]::ToDateTime([string]$Value) } catch { return $null }
}

function Get-ProductionQemuProcessesForPath {
    param([Parameter(Mandatory)][string]$ExpectedQemuPath)

    $resolved = [IO.Path]::GetFullPath($ExpectedQemuPath)
    $all = @(Get-CimInstance Win32_Process -Filter "Name = 'qemu-system-xtensa.exe'" -ErrorAction SilentlyContinue)
    return @($all | Where-Object {
        $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolved)
    })
}

function Select-ProductionOwnedQemuProcesses {
    param(
        [AllowEmptyCollection()]$Processes,
        [Parameter(Mandatory)][string]$ExpectedQemuPath,
        [Parameter(Mandatory)][int]$HarnessProcessId,
        [datetime]$StartedAt,
        [AllowEmptyCollection()][int[]]$KnownBefore = @()
    )

    $resolved = [IO.Path]::GetFullPath($ExpectedQemuPath)
    $known = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($id in @($KnownBefore)) { [void]$known.Add([int]$id) }

    $byPid = @{}
    foreach ($proc in @($Processes)) {
        if ($null -ne $proc.ProcessId) { $byPid[[int]$proc.ProcessId] = $proc }
    }

    function Test-DescendsFromHarness {
        param([int]$ChildPid, [int]$OwnerPid, $Index)
        $seen = New-Object 'System.Collections.Generic.HashSet[int]'
        $current = $ChildPid
        while ($Index.ContainsKey($current)) {
            if (-not $seen.Add($current)) { return $false }
            $parent = [int]$Index[$current].ParentProcessId
            if ($parent -eq $OwnerPid) { return $true }
            if ($parent -le 0 -or $parent -eq $current) { return $false }
            $current = $parent
        }
        return $false
    }

    return @($Processes | Where-Object {
        $pidValue = [int]$_.ProcessId
        if ($known.Contains($pidValue)) { return $false }
        if (-not $_.ExecutablePath) { return $false }
        if ([IO.Path]::GetFullPath($_.ExecutablePath) -ine $resolved) { return $false }

        $created = Convert-ProductionCimDateTime $_.CreationDate
        $createdOk = ($null -eq $StartedAt -or $null -eq $created -or $created -ge $StartedAt.AddSeconds(-2))
        $descendant = Test-DescendsFromHarness -ChildPid $pidValue -OwnerPid $HarnessProcessId -Index $byPid
        return ($createdOk -and $descendant)
    })
}

function Get-ProductionOwnedQemuProcesses {
    param(
        [Parameter(Mandatory)][string]$ExpectedQemuPath,
        [Parameter(Mandatory)][int]$HarnessProcessId,
        [datetime]$StartedAt,
        [AllowEmptyCollection()][int[]]$KnownBefore = @()
    )

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    return @(Select-ProductionOwnedQemuProcesses -Processes $all -ExpectedQemuPath $ExpectedQemuPath `
        -HarnessProcessId $HarnessProcessId -StartedAt $StartedAt -KnownBefore $KnownBefore)
}

function Stop-ProductionOwnedQemuProcesses {
    param(
        [AllowEmptyCollection()]$Processes,
        [Parameter(Mandatory)][string]$ExpectedQemuPath
    )

    $resolved = [IO.Path]::GetFullPath($ExpectedQemuPath)
    $stopped = @()
    foreach ($proc in @($Processes)) {
        if (-not $proc.ExecutablePath -or [IO.Path]::GetFullPath($proc.ExecutablePath) -ine $resolved) {
            continue
        }
        try {
            $live = Get-Process -Id ([int]$proc.ProcessId) -ErrorAction Stop
            $live.Kill()
            $live.WaitForExit(5000)
            $stopped += [pscustomobject]@{ processId = [int]$proc.ProcessId; executablePath = $proc.ExecutablePath }
        } catch {
            $stopped += [pscustomobject]@{ processId = [int]$proc.ProcessId; executablePath = $proc.ExecutablePath; error = $_.Exception.Message }
        }
    }
    return $stopped
}

function Get-ProductionProcessRuntimeInfo {
    param([Parameter(Mandatory)][int]$ProcessId)
    try {
        $proc = Get-Process -Id $ProcessId -ErrorAction Stop
        return [pscustomobject]@{
            processId = $ProcessId
            priorityClass = [string]$proc.PriorityClass
            processorAffinity = [int64]$proc.ProcessorAffinity
        }
    } catch {
        return [pscustomobject]@{
            processId = $ProcessId
            priorityClass = $null
            processorAffinity = $null
            error = $_.Exception.Message
        }
    }
}

function Get-ProductionRunFailureReasons {
    param(
        [AllowNull()]$HarnessExitCode,
        [bool]$ExternalBackstop = $false,
        [int]$SessionsDumped = 0,
        [int]$ExpectedSessions = 0,
        [int]$JsonlSessions = 0,
        [AllowNull()]$ClassifierSummary,
        [int]$OwnedOrphanCount = 0,
        [bool]$ChildInheritanceRequired = $false,
        [bool]$ChildInheritanceConfirmed = $true
    )

    $reasons = @()
    if ($null -eq $HarnessExitCode) {
        $reasons += 'harness_exit_code_unavailable'
    } elseif ([int]$HarnessExitCode -ne 0) {
        $reasons += "harness_exit_code_$HarnessExitCode"
    }
    if ($ExternalBackstop) { $reasons += 'external_timeout' }
    if ($ExpectedSessions -gt 0 -and $SessionsDumped -ne $ExpectedSessions) {
        $reasons += "incomplete_session_dump_${SessionsDumped}_of_$ExpectedSessions"
    }
    if ($ExpectedSessions -gt 0 -and $JsonlSessions -ne $ExpectedSessions) {
        $reasons += "incomplete_jsonl_${JsonlSessions}_of_$ExpectedSessions"
    }
    if ($null -ne $ClassifierSummary) {
        if ($ClassifierSummary.cellPass -ne $true) { $reasons += 'classifier_cellPass_false' }
        if ($ClassifierSummary.teardownClean -ne $true) { $reasons += 'classifier_teardown_dirty' }
        if ($ClassifierSummary.anyJsonlStderrMismatch -eq $true) { $reasons += 'classifier_jsonl_stderr_mismatch' }
    }
    if ($OwnedOrphanCount -gt 0) { $reasons += "owned_qemu_orphan_$OwnedOrphanCount" }
    if ($ChildInheritanceRequired -and -not $ChildInheritanceConfirmed) {
        $reasons += 'qemu_child_affinity_or_priority_unproven'
    }
    return @($reasons)
}

function Join-ProductionProcessArguments {
    param([AllowEmptyCollection()][string[]]$ArgumentList = @())

    $quoted = @()
    foreach ($arg in @($ArgumentList)) {
        $s = [string]$arg
        if ($s -notmatch '[\s"]') {
            $quoted += $s
            continue
        }
        $quoted += '"' + ($s -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
    }
    return ($quoted -join ' ')
}

function Invoke-ProductionProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [int]$TimeoutMilliseconds = 0,
        [switch]$BelowNormal,
        [IntPtr]$ProcessorAffinity = [IntPtr]::Zero,
        [string]$ExpectedChildQemuPath,
        [AllowEmptyCollection()][int[]]$KnownChildPidsBefore = @(),
        [int]$ExpectedChildCount = 0
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    if ($ArgumentList.Count -gt 0) {
        if ($null -ne $psi.ArgumentList) {
            # Available on newer .NET runtimes; avoids command-line re-parsing.
            foreach ($arg in $ArgumentList) { [void]$psi.ArgumentList.Add([string]$arg) }
        } else {
            # Windows PowerShell 5/.NET Framework fallback.
            $psi.Arguments = Join-ProductionProcessArguments -ArgumentList $ArgumentList
        }
    }
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $null = $process.Start()
    $startedAt = Get-Date
    try {
        if ($BelowNormal) { $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal }
        if ($ProcessorAffinity -ne [IntPtr]::Zero) { $process.ProcessorAffinity = $ProcessorAffinity }
    } catch {
        Write-Warning "could not constrain harness: $($_.Exception.Message)"
    }
    $harnessRuntimeInfo = Get-ProductionProcessRuntimeInfo -ProcessId $process.Id
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = $false
    $childSamples = @()
    $sampledChildPids = New-Object 'System.Collections.Generic.HashSet[int]'
    $deadline = if ($TimeoutMilliseconds -gt 0) { (Get-Date).AddMilliseconds($TimeoutMilliseconds) } else { $null }
    while (-not $process.HasExited) {
        if ($ExpectedChildQemuPath -and ($ExpectedChildCount -le 0 -or $sampledChildPids.Count -lt $ExpectedChildCount)) {
            $owned = @(Get-ProductionOwnedQemuProcesses -ExpectedQemuPath $ExpectedChildQemuPath `
                -HarnessProcessId $process.Id -StartedAt $startedAt -KnownBefore $KnownChildPidsBefore)
            foreach ($child in $owned) {
                $childPid = [int]$child.ProcessId
                if ($sampledChildPids.Add($childPid)) {
                    $info = Get-ProductionProcessRuntimeInfo -ProcessId $childPid
                    $childSamples += [pscustomobject]@{
                        processId = $childPid
                        parentProcessId = [int]$child.ParentProcessId
                        executablePath = $child.ExecutablePath
                        creationDate = $child.CreationDate
                        priorityClass = $info.priorityClass
                        processorAffinity = $info.processorAffinity
                    }
                }
            }
        }
        if ($null -ne $deadline -and (Get-Date) -ge $deadline) {
            $timedOut = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    if ($timedOut) {
        $timedOut = $true
        $process.Kill()
        $process.WaitForExit()
    } else {
        $process.WaitForExit()
    }
    $endedAt = Get-Date
    return [pscustomobject]@{
        processId = [int]$process.Id
        startedAt = $startedAt
        endedAt = $endedAt
        exitCode = if ($timedOut) { $null } else { [int]$process.ExitCode }
        timedOut = $timedOut
        stdout   = $stdoutTask.Result
        stderr   = $stderrTask.Result
        priorityClass = if ($null -eq $harnessRuntimeInfo) { $null } else { $harnessRuntimeInfo.priorityClass }
        processorAffinity = if ($null -eq $harnessRuntimeInfo) { $null } else { $harnessRuntimeInfo.processorAffinity }
        childSamples = @($childSamples)
    }
}
