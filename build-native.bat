@echo off
REM ── Build lrs_capture.exe (C++ DXGI capture service) ──────────────────
REM Requires: Visual Studio 2022 with C++ Desktop Development workload
REM
REM Usage:
REM   build-native.bat           — Release build
REM   build-native.bat Debug     — Debug build

setlocal

set BUILD_TYPE=%1
if "%BUILD_TYPE%"=="" set BUILD_TYPE=Release

REM Locate cmake from VS 2022
set CMAKE_EXE=
for /f "delims=" %%i in ('where cmake 2^>nul') do set CMAKE_EXE=%%i
if "%CMAKE_EXE%"=="" (
    set CMAKE_EXE=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe
)
if not exist "%CMAKE_EXE%" (
    echo ERROR: cmake not found. Install Visual Studio 2022 with C++ Desktop Development workload.
    exit /b 1
)

echo Using cmake: %CMAKE_EXE%

set SRC_DIR=%~dp0backend\native_capture
set BUILD_DIR=%SRC_DIR%\build

echo Configuring %BUILD_TYPE% build...
"%CMAKE_EXE%" -B "%BUILD_DIR%" -S "%SRC_DIR%" -DCMAKE_BUILD_TYPE=%BUILD_TYPE%
if errorlevel 1 (
    echo ERROR: cmake configure failed
    exit /b 1
)

echo Building...
"%CMAKE_EXE%" --build "%BUILD_DIR%" --config %BUILD_TYPE%
if errorlevel 1 (
    echo ERROR: cmake build failed
    exit /b 1
)

echo.
echo ══════════════════════════════════════════════════════════════
echo   lrs_capture.exe built successfully
echo   Location: %BUILD_DIR%\%BUILD_TYPE%\lrs_capture.exe
echo ══════════════════════════════════════════════════════════════

endlocal
