@echo off
setlocal enabledelayedexpansion
REM ══════════════════════════════════════════════════════════════════════
REM  build-native.bat  --  Build lrs_capture.exe (C++ WGC capture service)
REM  Requires: Visual Studio 2022 with C++ Desktop Development workload
REM
REM  Usage:
REM    build-native.bat           — incremental Release build (fast)
REM    build-native.bat clean     — full clean + rebuild
REM    build-native.bat Debug     — incremental Debug build
REM ══════════════════════════════════════════════════════════════════════

set ARG=%~1
set BUILD_TYPE=Release
set CLEAN_BUILD=0
if /i "%ARG%"=="clean" ( set CLEAN_BUILD=1 )
if /i "%ARG%"=="Debug" ( set BUILD_TYPE=Debug )

set SRC_DIR=%~dp0backend\native_capture
set BUILD_DIR=%SRC_DIR%\build
set EXE=%BUILD_DIR%\%BUILD_TYPE%\lrs_capture.exe

REM ── Kill any running lrs_capture.exe so the linker can overwrite it ──
tasklist /fi "imagename eq lrs_capture.exe" 2>nul | find /i "lrs_capture" >nul
if not errorlevel 1 (
    echo Killing existing lrs_capture.exe...
    taskkill /IM lrs_capture.exe /F >nul 2>&1
    timeout /t 1 /nobreak >nul
)

REM ── Locate cmake ──────────────────────────────────────────────────────
set CMAKE_EXE=
for /f "delims=" %%i in ('where cmake 2^>nul') do (
    set CMAKE_EXE=%%i
    goto :cmake_found
)

REM VS2022 known location (confirmed working)
set VS_CMAKE=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe
if exist "%VS_CMAKE%" (
    set CMAKE_EXE=%VS_CMAKE%
    goto :cmake_found
)

REM Try other VS2022 editions
for %%E in (Enterprise Professional BuildTools) do (
    set CANDIDATE=C:\Program Files\Microsoft Visual Studio\2022\%%E\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe
    if exist "!CANDIDATE!" (
        set CMAKE_EXE=!CANDIDATE!
        goto :cmake_found
    )
)

echo.
echo ERROR: cmake.exe not found.
echo.
echo TROUBLESHOOTING:
echo   1. Install Visual Studio 2022 Community (free):
echo      https://visualstudio.microsoft.com/vs/community/
echo   2. In the VS installer, select:
echo        Workload: "Desktop development with C++"
echo        Individual: "C++ CMake tools for Windows"
echo   3. Or add cmake to PATH manually and re-run.
echo.
exit /b 1

:cmake_found
echo Using cmake: %CMAKE_EXE%
echo Build type:  %BUILD_TYPE%
echo Source:      %SRC_DIR%
echo Output:      %EXE%
echo.

REM ── Clean if requested ────────────────────────────────────────────────
if "%CLEAN_BUILD%"=="1" (
    if exist "%BUILD_DIR%" (
        echo Cleaning build directory...
        rmdir /s /q "%BUILD_DIR%"
    )
)

REM ── Configure ─────────────────────────────────────────────────────────
echo Configuring...
"%CMAKE_EXE%" -B "%BUILD_DIR%" -S "%SRC_DIR%" -DCMAKE_BUILD_TYPE=%BUILD_TYPE%
if errorlevel 1 (
    echo.
    echo ERROR: cmake configure failed.
    echo TROUBLESHOOTING: Make sure the C++ Desktop Development workload is installed.
    exit /b 1
)

REM ── Build ─────────────────────────────────────────────────────────────
echo Building...
"%CMAKE_EXE%" --build "%BUILD_DIR%" --config %BUILD_TYPE%
if errorlevel 1 (
    echo.
    echo ERROR: cmake build failed.
    echo TROUBLESHOOTING:
    echo   - Check for compile errors above
    echo   - Ensure Windows SDK 10.0.17763+ is installed (for WinRT/WGC headers)
    echo   - Try: build-native.bat clean
    exit /b 1
)

REM ── Verify ────────────────────────────────────────────────────────────
if not exist "%EXE%" (
    echo.
    echo ERROR: Build reported success but %EXE% not found.
    exit /b 1
)

for %%F in ("%EXE%") do set EXE_SIZE=%%~zF
echo.
echo ══════════════════════════════════════════════════════════════
echo   lrs_capture.exe built successfully (%EXE_SIZE% bytes)
echo   %EXE%
echo ══════════════════════════════════════════════════════════════

endlocal
