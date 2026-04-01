@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — lrs.bat
REM
REM  With no arguments: launches the GUI.
REM  With arguments:    runs in headless CLI mode.
REM
REM  CLI Usage:
REM    lrs --project 1 --highlights
REM    lrs --project "My Race" --full-race --preset "Discord 720p30"
REM    lrs --project 1 --full-pipeline --upload
REM    lrs --project 1 --analyse-only
REM    lrs --help
REM
REM  Exit codes:
REM    0 = success
REM    1 = project error
REM    2 = iRacing not running
REM    3 = encoding failed
REM ═══════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "VENV=%BACKEND%\.venv"

REM ── Activate virtual environment ────────────────────────────
if exist "%VENV%\Scripts\activate.bat" (
    call "%VENV%\Scripts\activate.bat"
) else (
    echo WARNING: Virtual environment not found. Run start.bat first.
    echo          Trying system Python...
)

REM ── Launch (CLI or GUI depending on arguments) ──────────────
cd /d "%BACKEND%"
python app.py %*
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
