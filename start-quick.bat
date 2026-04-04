@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — Quick Start
REM  Skips install steps. Use when dependencies are already
REM  installed and frontend is already built.
REM
REM  Usage:
REM    start-quick.bat          — Launch in desktop window
REM    start-quick.bat --web    — Launch in default web browser
REM ═══════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "VENV=%BACKEND%\.venv"

REM ── Check for --web flag ───────────────────────────────────
set "WEB_ONLY=0"
for %%A in (%*) do (
    if /I "%%A"=="--web" set "WEB_ONLY=1"
)

echo.
echo  ========================================
echo      League Replay Studio  v0.1.0
echo           (Quick Start)
echo  ========================================
echo.

REM ── Activate virtual environment ───────────────────────────
if exist "%VENV%\Scripts\activate.bat" (
    call "%VENV%\Scripts\activate.bat"
) else (
    echo WARNING: Virtual environment not found. Run start.bat first.
    echo          Trying system Python...
)

REM ── Launch application ─────────────────────────────────────
echo Launching League Replay Studio...
echo.

cd /d "%BACKEND%"
python app.py %*

endlocal
