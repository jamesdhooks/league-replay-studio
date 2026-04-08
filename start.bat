@echo off
REM ═══════════════════════════════════════════════════════════
REM  League Replay Studio — Full Start
REM  Sets up the virtual environment, installs dependencies,
REM  builds the frontend, and launches the application.
REM ═══════════════════════════════════════════════════════════

setlocal EnableDelayedExpansion

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "VENV=%BACKEND%\.venv"
set "HAS_WEB=0"
set "HAS_RELOAD=0"
set "BUILD_NATIVE=0"
set "SKIP_NATIVE=0"
set "RUN_ARGS="

for %%A in (%*) do (
    if /I "%%A"=="--web"           set "HAS_WEB=1"
    if /I "%%A"=="--reload"        set "HAS_RELOAD=1"
    if /I "%%A"=="--build-native"  set "BUILD_NATIVE=1"
    if /I "%%A"=="--skip-native"   set "SKIP_NATIVE=1"
)

REM Pass through only the args that app.py understands
for %%A in (%*) do (
    if /I not "%%A"=="--build-native" if /I not "%%A"=="--skip-native" (
        set "RUN_ARGS=!RUN_ARGS! %%A"
    )
)

if "%HAS_WEB%"=="1" if "%HAS_RELOAD%"=="0" (
    set "RUN_ARGS=!RUN_ARGS! --reload"
)

echo.
echo  ========================================
echo       League Replay Studio  v0.1.0
echo  ========================================
echo.

REM ── Kill any existing LRS processes ────────────────────────
echo [0/6] Cleaning up old processes...

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%lrs-cleanup.ps1"

REM Brief pause so OS has time to release ports before we bind them again
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul

echo       Done.

REM ── Python virtual environment ─────────────────────────────
echo [1/6] Setting up Python environment...

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

REM ── Native C++ capture service ─────────────────────────────
echo [2/6] Native capture service...

set "NATIVE_SRC=%BACKEND%\native_capture"
set "NATIVE_EXE=%NATIVE_SRC%\build\Release\lrs_capture.exe"

if "%SKIP_NATIVE%"=="1" (
    echo       Skipping native capture build ^(--skip-native^).
    goto :native_done
)

if exist "%NATIVE_EXE%" (
    if "%BUILD_NATIVE%"=="0" (
        echo       lrs_capture.exe already built. Pass --build-native to rebuild.
        goto :native_done
    )
)

REM Locate cmake (bundled with VS 2022, or in PATH)
set "CMAKE_EXE="
for /f "delims=" %%i in ('where cmake 2^>nul') do (
    if "!CMAKE_EXE!"=="" set "CMAKE_EXE=%%i"
)
if "!CMAKE_EXE!"=="" (
    set "CMAKE_EXE=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
)

if not exist "!CMAKE_EXE!" (
    echo       [SKIP] Visual Studio 2022 not found -- native capture service will not be built.
    echo              To enable it, install VS 2022 with "Desktop development with C++" workload,
    echo              then re-run with --build-native, or run build-native.bat separately.
    goto :native_done
)

echo       Building lrs_capture.exe ^(C++ DXGI capture service^)...
"!CMAKE_EXE!" -B "%NATIVE_SRC%\build" -S "%NATIVE_SRC%" >nul 2>&1
if errorlevel 1 (
    echo       [WARN] CMake configure failed -- native capture will not be available.
    goto :native_done
)
"!CMAKE_EXE!" --build "%NATIVE_SRC%\build" --config Release >nul 2>&1
if errorlevel 1 (
    echo       [WARN] CMake build failed -- native capture will not be available.
    goto :native_done
)
echo       lrs_capture.exe built successfully.

:native_done

REM ── Node.js dependencies ───────────────────────────────────
echo [3/6] Setting up Node.js environment...

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
echo [4/6] Building frontend...

call npm run build --silent
if errorlevel 1 (
    echo ERROR: Frontend build failed.
    pause
    exit /b 1
)

REM ── Launch application ─────────────────────────────────────
echo [5/6] Launching League Replay Studio...
echo.

cd /d "%BACKEND%"
python app.py %RUN_ARGS%

REM Capture Python exit code and clean up remaining processes
set "PYTHON_EXIT_CODE=%ERRORLEVEL%"
echo.
echo [5/6] Cleaning up after exit...

REM Force-kill any remaining LRS processes on ports 7175 and 3174
REM (in case Python didn't terminate or Ctrl+C orphaned child processes)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%lrs-cleanup.ps1"

endlocal
exit /b %PYTHON_EXIT_CODE%

