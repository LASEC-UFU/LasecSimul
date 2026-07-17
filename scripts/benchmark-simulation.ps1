param(
    [string]$Executable = (Join-Path $PSScriptRoot "..\core\build\Release\simulation_performance_benchmark.exe"),
    [ValidateRange(1, [int]::MaxValue)]
    [int]$Scale = 100,
    [ValidateRange(1, [long]::MaxValue)]
    [long]$SimulatedNanoseconds = 1000000000,
    [ValidateRange(1, [int]::MaxValue)]
    [int]$SampleIntervalMilliseconds = 50
)

$ErrorActionPreference = "Stop"
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$logicalProcessors = [Environment]::ProcessorCount
$peakWorkingSetBytes = 0L
$peakThreadCount = 0
$peakProcessCpuPercent = 0.0
$threadCpuSeconds = @{}
$startedAt = [DateTime]::UtcNow
$lastSampleAt = $startedAt
$lastProcessCpuSeconds = 0.0

try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $resolvedExecutable
    $startInfo.Arguments = "--scale $Scale --sim-ns $SimulatedNanoseconds --profile"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Não foi possível iniciar o benchmark." }

    while (-not $process.HasExited) {
        $process.Refresh()
        $now = [DateTime]::UtcNow
        $elapsedSeconds = ($now - $lastSampleAt).TotalSeconds
        $processCpuSeconds = $process.TotalProcessorTime.TotalSeconds
        if ($elapsedSeconds -gt 0) {
            $cpuPercent = 100.0 * ($processCpuSeconds - $lastProcessCpuSeconds) /
                ($elapsedSeconds * $logicalProcessors)
            $peakProcessCpuPercent = [Math]::Max($peakProcessCpuPercent, $cpuPercent)
        }
        $lastSampleAt = $now
        $lastProcessCpuSeconds = $processCpuSeconds
        $peakWorkingSetBytes = [Math]::Max($peakWorkingSetBytes, $process.WorkingSet64)
        $peakThreadCount = [Math]::Max($peakThreadCount, $process.Threads.Count)
        foreach ($thread in $process.Threads) {
            $threadCpuSeconds[[string]$thread.Id] = $thread.TotalProcessorTime.TotalSeconds
        }
        Start-Sleep -Milliseconds $SampleIntervalMilliseconds
    }

    $process.WaitForExit()
    $benchmarkOutput = $process.StandardOutput.ReadToEnd()
    $benchmarkError = $process.StandardError.ReadToEnd()
    if ($benchmarkOutput) { Write-Output $benchmarkOutput.TrimEnd() }
    if ($benchmarkError) { Write-Error $benchmarkError.TrimEnd() }
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
        throw "Benchmark terminou com código $exitCode."
    }

    $threadSummary = $threadCpuSeconds.GetEnumerator() |
        Sort-Object Value -Descending |
        ForEach-Object { [ordered]@{ threadId = [int]$_.Key; cpuSeconds = [Math]::Round($_.Value, 6) } }
    $summary = [ordered]@{
        executable = $resolvedExecutable
        exitCode = $exitCode
        scale = $Scale
        simulatedNanoseconds = $SimulatedNanoseconds
        wallSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 6)
        logicalProcessors = $logicalProcessors
        peakProcessCpuPercentOfMachine = [Math]::Round($peakProcessCpuPercent, 2)
        peakWorkingSetMiB = [Math]::Round($peakWorkingSetBytes / 1MB, 2)
        peakThreadCount = $peakThreadCount
        finalCpuSecondsByThread = @($threadSummary)
    }
    Write-Output ($summary | ConvertTo-Json -Depth 4)
}
finally {
    if ($null -ne $process) { $process.Dispose() }
}
