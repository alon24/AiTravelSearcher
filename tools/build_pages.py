"""Build the static site for GitHub Pages: the web UI with its /api answered inside the browser (web/local/backend.js).

    python3 tools/build_pages.py _site      # then serve _site/ with any static file server

Data files are copied next to it: config.json (airline sites, bag notes and city airports, from data/config.json)
and local/airport_tz.json (airport time zones, for connection checks).

Real fares need Skyhop's Cloudflare Worker (worker/README.md): set SKYHOP_WORKER_URL and SKYHOP_GOOGLE_CLIENT_ID (CI
reads them from GitHub variables) and the page offers Google sign-in; without them it shows demo fares only.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "src" / "flightagent"


def runtime() -> str:
    rt = {}
    for key, env in (("workerUrl", "SKYHOP_WORKER_URL"), ("googleClientId", "SKYHOP_GOOGLE_CLIENT_ID")):
        if os.environ.get(env, "").strip():
            rt[key] = os.environ[env].strip()
    return f"window.SKYHOP_RUNTIME = {json.dumps(rt)};   // built by tools/build_pages.py\n"


def build(out: Path) -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(PKG / "web", out, ignore=shutil.ignore_patterns("*.test.js"))
    (out / "runtime.js").write_text(runtime())
    shutil.copy(PKG / "data" / "config.json", out / "config.json")
    shutil.copy(PKG / "data" / "airport_tz.json", out / "local" / "airport_tz.json")
    (out / ".nojekyll").touch()     # serve files as they are
    return out


if __name__ == "__main__":
    print(build(Path(sys.argv[1] if len(sys.argv) > 1 else "_site")))
