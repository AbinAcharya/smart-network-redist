@echo off
cd /d "%~dp0"
set "FLOWSTATE_PORT=8012"
python server.py
if errorlevel 1 pause
