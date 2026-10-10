@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  Quirex stop
REM
REM  ASCII only on purpose: cmd.exe parses .bat files with the console
REM  code page, and non-ASCII text in a command line can break parsing
REM  (or swallow the following line) when the console is not UTF-8.
REM ============================================================

echo.
echo ============================================================
echo   Quirex   ^(stopping^)
echo ============================================================
echo.

set FOUND=0
set "SEEN= "

REM Find whatever listens on port 3000 and stop it, but only if it is node.
REM The same listener shows up twice in netstat (0.0.0.0:3000 and [::]:3000 with
REM the same PID), so de-duplicate by PID -- otherwise the second copy looks up a
REM dead process and gets misreported as "not node".
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":3000 "') do call :killone %%p
goto :done

:killone
echo !SEEN! | findstr /c:" %1 " >nul && goto :eof
set "SEEN=!SEEN!%1 "

set ISNODE=0
for /f "delims=" %%n in ('tasklist /FI "PID eq %1" /NH 2^>nul ^| findstr /i "node"') do set ISNODE=1
if "!ISNODE!"=="1" (
  echo Stopping node process PID %1
  taskkill /PID %1 /F >nul 2>nul
  set FOUND=1
) else (
  echo [SKIP] PID %1 holds port 3000 but is not node - left alone.
)
goto :eof

:done
if "!FOUND!"=="0" (
  echo Nothing is listening on port 3000 ^(the service is already stopped^).
) else (
  echo.
  echo Stopped. If the "Quirex service" window is still open, just close it.
)

echo.
echo Press any key to close this window...
pause >nul
endlocal
