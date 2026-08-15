@echo off
cd /d "%~dp0"
node scripts\harness-agent.mjs --stop
if errorlevel 1 pause
