@echo off
REM Set environment variables if needed
REM set CLAUDE_CLI_PATH=C:\custom\path\to\claude.exe

REM Get the directory of this script
SET SCRIPT_DIR=%~dp0

REM Start the server with the correct path
where bun >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  bun "%SCRIPT_DIR%dist\server.js"
  goto :EOF
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node "%SCRIPT_DIR%dist\server.js"
  goto :EOF
)

echo Error: Neither bun nor node found in PATH
exit /b 127
