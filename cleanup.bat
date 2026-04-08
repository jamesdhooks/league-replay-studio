@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — Cleanup Utility
REM  Kills any processes holding LRS ports (7175, 3174)
REM  or the lrs_capture service, with before/after validation.
REM ═══════════════════════════════════════════════════════════

set "ROOT=%~dp0"

REM ── Self-elevate if not already admin ──────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/k cd /d ""%ROOT%"" && ""%ROOT%cleanup.bat""' -Verb RunAs"
    exit /b
)

echo.
echo  ========================================
echo       LRS Cleanup Utility  [Administrator]
echo  ========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%lrs-cleanup.ps1" -ShowDetails

echo.
pause

echo.
pause
