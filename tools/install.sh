#!/usr/bin/env bash
# One-command install of the Skyhop server (Docker) on Linux or macOS. Safe to re-run: it only creates what is missing
# and rebuilds the container. Windows: follow docs/INSTALL.md (PowerShell commands). Run from anywhere:  tools/install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

say "1/4  Checking Docker"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop (macOS/Windows) or Docker Engine + the compose plugin (Linux): https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running (or your user can't use it). Start Docker, or on Linux: sudo usermod -aG docker \$USER, then log out and in."
docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin is missing. See https://docs.docker.com/compose/install/"

say "2/4  Settings file (.env)"
if [ -f .env ]; then
  echo ".env already exists, leaving it alone."
else
  cp .env.example .env
  echo "Created .env from .env.example (free Google Flights scraper, no keys needed)."
fi

say "3/4  Docker network"
# docker-compose.yml joins a network called n8n_default (so an n8n container can reach the app). Create it if you don't run n8n.
if docker network inspect n8n_default >/dev/null 2>&1; then
  echo "Network n8n_default already exists."
else
  docker network create n8n_default >/dev/null
  echo "Created network n8n_default."
fi

say "4/4  Building and starting Skyhop"
docker compose up -d --build
for i in $(seq 1 40); do
  if curl -fsS -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; then UP=1; break; fi
  sleep 2
done
[ "${UP:-0}" = "1" ] || die "The server did not answer on http://127.0.0.1:8765/health. Look at:  docker compose logs flightagent"

cat <<MSG

$(printf '\033[32m')Skyhop is running:  http://localhost:8765/$(printf '\033[0m')

Next: the Chrome extension (lets a flight row open the airline's site with that flight selected)
  1. Open Chrome, go to  chrome://extensions
  2. Switch on "Developer mode" (top right)
  3. Click "Load unpacked" and choose this folder:
       $ROOT/browser-extension
  4. Click "Details" on Skyhop Airline Assist, and under "Site access" choose
     "Automatically allow access on the following sites".
  5. Reload http://localhost:8765/ : you should see "ASSIST ON" in the header.

Then open .env if you want more: a SerpApi key, or an OpenRouter key for the Jev model
(the header badge switches between Laya and Jev). Full guide: docs/INSTALL.md
MSG
