@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — Full Start
REM  Sets up the virtual environment, installs dependencies,
REM  builds the frontend, and launches the application.
REM
REM  Usage:
REM    start.bat          — Launch in desktop window (pywebview)
REM    start.bat --web    — Launch in default web browser
REM ═══════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"

REM ── Check for --web flag ───────────────────────────────────
set "WEB_ONLY=0"
for %%A in (%*) do (
    if /I "%%A"=="--web" set "WEB_ONLY=1"
)

echo.
echo  ========================================
echo       League Replay Studio  v0.1.0
echo  ========================================
echo.

REM ── Python virtual environment ─────────────────────────────
echo [1/4] Setting up Python environment...

if not exist "%VENV%\Scripts\activate.bat" (
    echo       Creating virtual environment (Python 3.11^)...
    py -3.11 -m venv "%VENV%"
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        echo        Please ensure Python 3.11 is installed: https://python.org/downloads
        pause
        exit /b 1
    )
)

call "%VENV%\Scripts\activate.bat"

echo       Installing Python dependencies...
pip install -r "%BACKEND%\requirements.txt" --quiet
if errorlevel 1 (
    echo ERROR: Failed to install Python dependencies.
    pause
    exit /b 1
)

REM ── Node.js dependencies ───────────────────────────────────
echo [2/4] Setting up Node.js environment...

cd /d "%FRONTEND%"
if not exist "node_modules" (
    echo       Installing Node.js dependencies...
    call npm install --silent
    if errorlevel 1 (
        echo ERROR: Failed to install Node.js dependencies. Is Node.js installed?
        pause
        exit /b 1
    )
) else (
    echo       Node modules already installed.
)

REM ── Build frontend ─────────────────────────────────────────
echo [3/4] Building frontend...

call npm run build --silent
if errorlevel 1 (
    echo ERROR: Frontend build failed.
    pause
    exit /b 1
)

REM ── Launch application ─────────────────────────────────────
echo [4/4] Launching League Replay Studio...
if "%WEB_ONLY%"=="1" (
    echo       Mode: Web Browser
    set "WEB_ONLY=1"
) else (
    echo       Mode: Desktop Window
)
echo.

cd /d "%BACKEND%"
python app.py %*

endlocal
