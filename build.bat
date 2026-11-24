@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Error: Node.js is not installed or is not available in PATH.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Error: npm is not available in PATH.
  exit /b 1
)

if not exist "node_modules" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    echo Error: Failed to install project dependencies.
    exit /b 1
  )
)

call npm run build
if errorlevel 1 (
  echo Error: Build failed.
  exit /b 1
)

echo.
echo Build complete. Check the dist folder for the installer.
exit /b 0
