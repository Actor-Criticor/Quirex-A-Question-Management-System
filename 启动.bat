@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  Quirex one-click launcher
REM
REM  Everything functional in this file is plain ASCII **on purpose**:
REM  cmd.exe parses .bat files using the console code page, so a
REM  non-ASCII path/command line breaks when the console is not UTF-8
REM  (which is what you get on a plain double-click). Chinese text in a
REM  command line can even swallow the following line. So: no Chinese
REM  here at all -- the app folder is *found*, not spelled out.
REM ============================================================

REM ---------- locate the app folder (the one holding package.json) ----------
set "APPDIR="
for /d %%d in ("%~dp0*") do if exist "%%~fd\package.json" set "APPDIR=%%~fd"
if not defined APPDIR (
  echo.
  echo [ERROR] Cannot find the app folder.
  echo         This file must sit next to the folder that contains package.json
  echo         ^(usually called "code"^), together with the data folders.
  echo.
  goto :end
)
cd /d "!APPDIR!"

echo.
echo ============================================================
echo   Quirex   ^(starting^)
echo ============================================================
echo.

REM ---------- 1. Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo         Install Node.js 20 or newer from https://nodejs.org/
  echo         and double-click this file again.
  goto :end
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/4] Node.js !NODEVER!  OK

REM ---------- 2. dependencies ----------
if not exist "node_modules" (
  echo [2/4] First run: installing dependencies ^(takes a few minutes, once^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and try again.
    goto :end
  )
) else (
  echo [2/4] dependencies OK
)

REM ---------- 3. xelatex (optional: only needed to auto-compile the PDF) ----------
where xelatex >nul 2>nul
if errorlevel 1 (
  echo [3/4] WARNING: xelatex not found.
  echo         Everything still works; the exported handout just will not be
  echo         compiled automatically ^(double-click build.bat in the export
  echo         folder later^). Install TeX Live / MiKTeX, or set the full path
  echo         in Settings - Paths.
) else (
  echo [3/4] xelatex OK
)

REM ---------- 4. build (only when there is no build output yet) ----------
if not exist ".next\BUILD_ID" (
  echo [4/4] Building ^(about 1 minute the first time^)...
  call npm run build
  if errorlevel 1 (
    echo [ERROR] Build failed.
    echo         Run "npm run dev" inside the app folder to see the details.
    goto :end
  )
) else (
  echo [4/4] build OK
)

REM ---------- port check ----------
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":3000 " >nul 2>nul
if not errorlevel 1 (
  echo.
  echo [WARN] Port 3000 is already in use - a previous run may still be alive.
  echo        Run stop.bat first ^(or close that service window^), then retry.
  goto :end
)

echo.
echo ------------------------------------------------------------
echo   The service runs in ANOTHER window; closing that window
echo   stops it. This window opens your browser once it is ready.
echo ------------------------------------------------------------
echo.

echo Starting the service...
start "Quirex service" cmd /k "npm start"

REM ---------- wait until the port is really listening (max ~40s) ----------
set /a TRIES=0
:waitloop
set /a TRIES+=1
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":3000 " >nul 2>nul
if errorlevel 1 (
  if !TRIES! lss 20 goto waitloop
  echo [WARN] Not ready after 40 seconds - check the "Quirex service" window.
  goto :end
)

echo Service is ready. Opening the browser...
start "" http://localhost:3000
echo.
echo Done. To stop: run stop.bat, or close the "Quirex service" window.

:end
echo.
echo Press any key to close this window...
pause >nul
endlocal
