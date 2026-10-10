"""Build the static, server-less site for GitHub Pages: the web UI with its /api answered inside the browser
(web/local/backend.js) instead of by the Python service.

    python3 tools/build_pages.py _site      # then serve _site/ with any static file server

Data the server would send at run time is written out as files: config.json (airline sites and bag notes from
links.py) and local/airport_tz.json (airport time zones, for connection checks).

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
    rt = {"backend": "browser"}
    for key, env in (("workerUrl", "SKYHOP_WORKER_URL"), ("googleClientId", "SKYHOP_GOOGLE_CLIENT_ID")):
        if os.environ.get(env, "").strip():
            rt[key] = os.environ[env].strip()
    return f"window.SKYHOP_RUNTIME = {json.dumps(rt)};   // built by tools/build_pages.py\n"


def build(out: Path) -> Path:
    sys.path.insert(0, str(ROOT / "src"))
    from flightagent.links import AIRLINE_SITES, BAG_NOTES, BAG_SHORT, KNOWN_AIRLINES

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(PKG / "web", out, ignore=shutil.ignore_patterns("*.test.js"))
    (out / "runtime.js").write_text(runtime())
    config = {"airline_sites": AIRLINE_SITES, "airlines": KNOWN_AIRLINES, "bag_notes": BAG_NOTES, "bag_short": BAG_SHORT}
    (out / "config.json").write_text(json.dumps(config, ensure_ascii=False))
    shutil.copy(PKG / "data" / "airport_tz.json", out / "local" / "airport_tz.json")
    (out / ".nojekyll").touch()     # serve files as they are
    return out


if __name__ == "__main__":
    print(build(Path(sys.argv[1] if len(sys.argv) > 1 else "_site")))
