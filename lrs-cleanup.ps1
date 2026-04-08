# lrs-cleanup.ps1 - Kill any processes holding LRS ports (7175, 3174) or named lrs_capture.
# Called from start.bat at startup and after Python exits.
# Pass -ShowDetails for before/after diagnostic output (used by cleanup.bat).
param([switch]$ShowDetails)

$ports = @(7175, 3174)
$namedServices = @('lrs_capture')

function Show-LrsStatus {
    param([string]$Label)
    if (-not $ShowDetails) { return }
    Write-Host "  [$Label]"
    $any = $false
    foreach ($port in $ports) {
        $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        foreach ($c in @($conns)) {
            $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            $procName = if ($proc) { $proc.ProcessName } else { "PID $($c.OwningProcess)" }
            Write-Host ("    port $port  " + ([string]$c.State).PadRight(12) + "  PID $($c.OwningProcess)  ($procName)")
            $any = $true
        }
    }
    foreach ($name in $namedServices) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host ("    named   " + $_.ProcessName.PadRight(20) + "  PID $($_.Id)")
            $any = $true
        }
    }
    if (-not $any) { Write-Host '    (none)' }
    Write-Host ''
}

if ($ShowDetails) { Write-Host 'Before cleanup:' }
Show-LrsStatus 'snapshot'

$killed = 0

function Invoke-Kill {
    param([int]$TargetPid, [string]$Label)
    Write-Host "  Kill $Label (PID $TargetPid)"
    # Try taskkill first - works cross-privilege when elevated
    $result = & "$env:SystemRoot\System32\taskkill.exe" /F /PID $TargetPid 2>&1
    Write-Host "    taskkill: $result"
    # WMI fallback
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    taskkill failed (exit $LASTEXITCODE), trying WMI..."
        $wmiProc = Get-WmiObject Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue
        if ($wmiProc) {
            $r = $wmiProc.Terminate()
            Write-Host "    WMI Terminate() returned: $($r.ReturnValue)"
        } else {
            Write-Host "    WMI: process not found (may already be gone)"
        }
    }
}

# Kill by port - whatever is actually LISTENING on LRS ports
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in @($conns)) {
        $ownerPid = $conn.OwningProcess
        if ($ownerPid -and $ownerPid -ne 0) {
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            $procName = if ($proc) { $proc.ProcessName } else { 'process' }
            if ($ShowDetails) {
                # Check if process exists at all before trying
                $exists = [bool](Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
                if (-not $exists) {
                    # Try to see it via WMI (catches elevated/system processes)
                    $wmiCheck = Get-WmiObject Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
                    if (-not $wmiCheck) {
                        Write-Host "  PID $ownerPid on port $port - process not visible (ghost socket or elevated process)"
                        Write-Host "    Attempting taskkill anyway..."
                    }
                }
                Invoke-Kill -TargetPid $ownerPid -Label "$procName on port $port"
            } else {
                & "$env:SystemRoot\System32\taskkill.exe" /F /PID $ownerPid 2>&1 | Out-Null
                Write-Host "      Force-killing $procName (PID $ownerPid) on port $port"
            }
            $killed++
        }
    }
}

# Kill lrs_capture by name (always LRS-specific)
foreach ($name in $namedServices) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
        if ($ShowDetails) {
            Invoke-Kill -TargetPid $_.Id -Label "$($_.ProcessName) (named service)"
        } else {
            Write-Host "      Force-killing $($_.ProcessName) (PID $($_.Id))"
            & "$env:SystemRoot\System32\taskkill.exe" /F /PID $_.Id 2>&1 | Out-Null
        }
        $killed++
    }
}

if ($killed -eq 0) {
    if ($ShowDetails) { Write-Host '  Nothing to kill.' }
    else {
        # Check for ghost sockets (dead PID still holding port) and wait them out
        $ghosts = @()
        foreach ($port in $ports) {
            $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in @($conns)) {
                $ownerPid = $c.OwningProcess
                if ($ownerPid -and $ownerPid -ne 0 -and -not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
                    $ghosts += @{ Port = $port; Pid = $ownerPid }
                }
            }
        }
        if ($ghosts.Count -gt 0) {
            Write-Host "      Ghost socket on port(s): process dead, waiting for OS to reclaim (up to 15s)..."
            for ($i = 1; $i -le 15; $i++) {
                Start-Sleep -Seconds 1
                $still = $false
                foreach ($g in $ghosts) {
                    if (Get-NetTCPConnection -LocalPort $g.Port -State Listen -ErrorAction SilentlyContinue) { $still = $true }
                }
                if (-not $still) { Write-Host "      Port cleared after ${i}s."; break }
            }
        } else {
            Write-Host '      No stale LRS processes found.'
        }
    }
} else {
    if ($ShowDetails) { Write-Host ''; Write-Host '  Waiting for OS to release ports...' }
    else              { Write-Host "      Killed $killed process(es)." }
    Start-Sleep -Milliseconds 1000
}

if ($ShowDetails) {
    Write-Host ''
    Write-Host 'After cleanup:'
    Show-LrsStatus 'snapshot'

    # Final validation - distinguish ghost sockets (dead PID) from live processes
    $liveRemaining = 0
    $ghostSockets  = 0
    foreach ($port in $ports) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in @($conns)) {
            $ownerPid = $c.OwningProcess
            $procExists = $ownerPid -and $ownerPid -ne 0 -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
            if ($procExists) { $liveRemaining++ }
            else             { $ghostSockets++ }
        }
    }
    foreach ($name in $namedServices) {
        if (Get-Process -Name $name -ErrorAction SilentlyContinue) { $liveRemaining++ }
    }

    if ($liveRemaining -eq 0 -and $ghostSockets -eq 0) {
        Write-Host '  All clear. Ports 7175 and 3174 are free.'
    } elseif ($liveRemaining -gt 0) {
        Write-Host "  WARNING: $liveRemaining live process(es) still holding ports - manual intervention needed."
        Write-Host '  Run: Get-NetTCPConnection -LocalPort 7175,3174 | Select LocalPort,State,OwningProcess'
    } else {
        # Ghost sockets only - process is dead, just waiting for OS TCP cleanup
        Write-Host "  Ghost socket detected ($ghostSockets): process is dead, OS is reclaiming TCP state."
        Write-Host '  Waiting up to 30 seconds for port to clear...'
        $cleared = $false
        for ($i = 1; $i -le 30; $i++) {
            Start-Sleep -Seconds 1
            $stillThere = Get-NetTCPConnection -LocalPort 7175 -State Listen -ErrorAction SilentlyContinue
            if (-not $stillThere) {
                Write-Host "  Port cleared after ${i}s. All clear."
                $cleared = $true
                break
            }
            if ($i % 5 -eq 0) { Write-Host "  Still waiting... (${i}s)" }
        }
        if (-not $cleared) {
            Write-Host '  Port did not clear in 30s. This is harmless - uvicorn will reclaim it on next start.'
        }
    }
}
