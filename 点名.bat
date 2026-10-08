@echo off
rem ---------------------------------------------------------------------
rem  One-click launcher for the random-picker page.
rem
rem  Double-click this file: it picks the first roster file inside the
rem  "roster" folder (xlsx -> csv -> txt), loads it, and opens the
rem  browser. If that folder is empty it just opens the page.
rem
rem  Keep this .bat in the attendance-system root folder.
rem  This file is deliberately ASCII-only: cmd.exe parses .bat bytes using
rem  the active codepage, so non-ASCII literals here are fragile.
rem ---------------------------------------------------------------------

chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "LAUNCH=skills\random-picker\scripts\launch.py"

if not exist "%LAUNCH%" (
    echo [ERROR] Cannot find "%LAUNCH%".
    echo         Keep this .bat in the attendance-system root folder.
    pause
    exit /b 1
)

set "ROSTER="
for %%E in (xlsx csv txt) do (
    for %%F in ("roster\*.%%E") do (
        if not defined ROSTER if exist "%%~fF" set "ROSTER=%%~fF"
    )
)

if defined ROSTER (
    echo Loading roster: !ROSTER!
    python "%LAUNCH%" --roster "!ROSTER!"
) else (
    echo No roster file found in the "roster" folder - opening the page as is.
    python "%LAUNCH%"
)

if errorlevel 1 (
    echo.
    echo [ERROR] Launch failed.
    echo         Check that "python" works:   python -V
    echo         On this machine use "python", NOT "python3".
    echo.
    pause
)
