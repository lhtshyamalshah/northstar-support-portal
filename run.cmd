@echo off
rem One-command production run (Windows). Uses prebuilt images when present.
cd /d "%~dp0"
docker info >nul 2>&1 || (echo Docker Desktop must be installed and running.& exit /b 1)
setlocal enabledelayedexpansion
set FOUND=
for %%t in (*.image.tar.gz) do (
    docker load -i "%%t" || exit /b 1
    set FOUND=1
)
if not defined FOUND docker compose build || exit /b 1
docker compose up -d --no-build || exit /b 1
if not defined APP_PORT set APP_PORT=3000
echo Northstar Support Portal starting at http://localhost:%APP_PORT%
