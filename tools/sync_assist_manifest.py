"""Regenerate browser-extension/manifest.json's host_permissions (and bump nothing else) from airlines.json.

Every airline's registrable domains become `https://*.<domain>/*` (covers www., booking. and the apex), plus what the
background script calls: the local Laya service, the local Skyhop server and the web version's Worker. Run after
editing browser-extension/airlines.json:

    python3 tools/sync_assist_manifest.py          # rewrite
    python3 tools/sync_assist_manifest.py --check  # exit 1 if manifest.json is out of date (used by the tests)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent / "browser-extension"
LAYA = "http://127.0.0.1:8799/*"      # the local decision service
WORKER = "https://*.workers.dev/*"    # Skyhop's Cloudflare Worker: /decide (Jev)


def expected_hosts(registry: dict) -> list[str]:
    hosts = sorted({f"https://*.{d}/*" for a in registry["airlines"].values() for d in a["hosts"]})
    return hosts + [LAYA, WORKER]


def main(argv: list[str]) -> int:
    registry = json.loads((EXT / "airlines.json").read_text())
    manifest_path = EXT / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    want = expected_hosts(registry)
    if manifest.get("host_permissions") == want:
        return 0
    if "--check" in argv:
        print("manifest.json host_permissions is out of date; run tools/sync_assist_manifest.py", file=sys.stderr)
        return 1
    manifest["host_permissions"] = want
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(want)} host permissions")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
