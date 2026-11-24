@echo off
setlocal

if exist "%~dp0node_modules\.bin\electron.cmd" (
  start "" "%~dp0node_modules\.bin\electron.cmd" "%~dp0."
) else (
  start "" chrome --app="%~dp0index.html" --enable-features=ClipboardUnsanitizedFormats
)
