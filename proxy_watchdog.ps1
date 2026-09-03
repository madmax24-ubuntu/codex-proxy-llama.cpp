param([switch]$SelfTest)

function Test-RestartRequired([bool]$ProcessAlive, [int]$Failures, [int]$Threshold) {
    return (-not $ProcessAlive) -or $Failures -ge $Threshold
}

if ($SelfTest) {
    if ((Test-RestartRequired $true 1 6) -or (Test-RestartRequired $true 5 6) -or -not (Test-RestartRequired $true 6 6) -or -not (Test-RestartRequired $false 0 6)) { throw 'watchdog threshold self-test failed' }
    Write-Output 'WATCHDOG SELFTEST PASS'
    exit 0
}

$codePath = if ($env:QW_CODE_PATH) { [IO.Path]::GetFullPath($env:QW_CODE_PATH) } else { $null }
$proxyScript = [IO.Path]::GetFullPath($env:PROXY_SCRIPT)
$proxyPidFile = [IO.Path]::GetFullPath($env:PROXY_PID_FILE)
$watchdogLog = if ($env:PROXY_WATCHDOG_LOG) { [IO.Path]::GetFullPath($env:PROXY_WATCHDOG_LOG) } else { Join-Path $env:CODEX_HOME 'proxy-watchdog.log' }
$failureThreshold = 6
if ($env:CODEX_PROXY_WATCHDOG_FAILURE_THRESHOLD) { $failureThreshold = [Math]::Max(2, [int]$env:CODEX_PROXY_WATCHDOG_FAILURE_THRESHOLD) }

function Write-WatchdogLog([string]$Message) {
    try { Add-Content -LiteralPath $watchdogLog -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8 } catch { }
}

function Get-CodeProcesses {
    if (-not $codePath) { return @($PID) }
    return @(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $codePath) } catch { $false } })
}

function Get-ProxyProcess {
    if (-not (Test-Path -LiteralPath $proxyPidFile)) { return $null }
    $value = Get-Content -LiteralPath $proxyPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $proxyProcessId = 0
    if (-not [int]::TryParse([string]$value, [ref]$proxyProcessId)) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$proxyProcessId" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -ieq 'node.exe' -and $process.CommandLine -like ('*' + [IO.Path]::GetFileName($proxyScript) + '*')) { return $process }
    return $null
}

function Test-ProxyHealth([int]$TimeoutSec) {
    try {
        $response = Invoke-RestMethod ("http://127.0.0.1:$($env:CODEX_PROXY_PORT)/health") -TimeoutSec $TimeoutSec
        return [bool]$response.ok
    } catch { return $false }
}

function Start-ProxyProcess {
    $process = Start-Process -FilePath 'node.exe' -ArgumentList @($proxyScript) -WorkingDirectory $env:CODEX_HOME -WindowStyle Hidden -RedirectStandardOutput $env:PROXY_STDOUT -RedirectStandardError $env:PROXY_STDERR -PassThru
    if (-not $process) { Write-WatchdogLog 'restart_failed no_process'; return $false }
    Set-Content -LiteralPath $proxyPidFile -Value $process.Id -Encoding ASCII
    Write-WatchdogLog "restart_started pid=$($process.Id)"
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-ProxyHealth 3) { Write-WatchdogLog "restart_ready pid=$($process.Id) attempt=$attempt"; return $true }
        if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    }
    Write-WatchdogLog "restart_unhealthy pid=$($process.Id)"
    return $false
}

$seen = -not $codePath
for ($attempt = 0; -not $seen -and $attempt -lt 60; $attempt++) {
    if ((Get-CodeProcesses).Count -gt 0) { $seen = $true; break }
    Start-Sleep -Milliseconds 500
}

if ($seen) {
    $missing = 0
    $healthFailures = 0
    Write-WatchdogLog "started threshold=$failureThreshold"
    while ($true) {
        Start-Sleep -Seconds 2
        if ($codePath -and (Get-CodeProcesses).Count -eq 0) {
            $missing++
            if ($missing -ge 15) { Write-WatchdogLog 'code_closed'; break }
            continue
        }
        $missing = 0
        $proxyProcess = Get-ProxyProcess
        if (-not $proxyProcess) {
            Write-WatchdogLog 'proxy_process_missing restart=1'
            Remove-Item -LiteralPath $proxyPidFile -Force -ErrorAction SilentlyContinue
            [void](Start-ProxyProcess)
            $healthFailures = 0
            continue
        }
        if (Test-ProxyHealth 3) {
            if ($healthFailures -gt 0) { Write-WatchdogLog "health_recovered failures=$healthFailures pid=$($proxyProcess.ProcessId)" }
            $healthFailures = 0
            continue
        }
        $healthFailures++
        Write-WatchdogLog "health_failed failures=$healthFailures threshold=$failureThreshold pid=$($proxyProcess.ProcessId)"
        if (-not (Test-RestartRequired $true $healthFailures $failureThreshold)) { continue }
        if (Test-ProxyHealth 10) {
            Write-WatchdogLog "health_recovered final_probe=1 failures=$healthFailures pid=$($proxyProcess.ProcessId)"
            $healthFailures = 0
            continue
        }
        Write-WatchdogLog "restart_confirmed failures=$healthFailures pid=$($proxyProcess.ProcessId)"
        Stop-Process -Id $proxyProcess.ProcessId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Remove-Item -LiteralPath $proxyPidFile -Force -ErrorAction SilentlyContinue
        [void](Start-ProxyProcess)
        $healthFailures = 0
    }
}
