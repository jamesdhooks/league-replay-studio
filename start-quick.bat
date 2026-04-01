@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — Quick Start
REM  Skips install steps. Use when dependencies are already
REM  installed and frontend is already built.
REM ═══════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "VENV=%BACKEND%\.venv"

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
