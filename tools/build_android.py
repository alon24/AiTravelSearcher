"""Build the script the Skyhop Android app (android/) runs in its Skyhop page: the Airline Assist extension's own
background.js and content-bridge.js, unchanged, on the chrome.* calls android/web/app-shim.js provides, with the
extension's airline list and drivers inside it (the airline tab runs them).

    python3 tools/build_android.py      # writes android/app/src/main/assets/skyhop-app.js (CI does this before Gradle)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "browser-extension"
WEB = ROOT / "android" / "web"
OUT = ROOT / "android" / "app" / "src" / "main" / "assets" / "skyhop-app.js"


def files() -> dict[str, str]:
    """What the extension reads with chrome.runtime.getURL or injects by file name, by the same paths."""
    out = {"airlines.json": (EXT / "airlines.json").read_text(), "airline-bridge.js": (WEB / "airline-bridge.js").read_text()}
    for f in sorted((EXT / "drivers").glob("*.js")):
        out[f"drivers/{f.name}"] = f.read_text()
    return out


def bundle() -> str:
    # The scripts are pasted in as they are; each gets its own `chrome`, as the extension's two sides do.
    return f"""/* Built by tools/build_android.py from android/web/ and browser-extension/: edit those, not this. */
(function () {{
  if (window !== window.top || window.SkyhopShim || !window.SkyhopNative) return;
  window.SKYHOP_APP = true;
  window.SKYHOP_BUILD = {json.dumps(os.environ.get("GITHUB_SHA", "local")[:7])};   // the commit this APK was built from
{(WEB / "app-shim.js").read_text()}
  window.SkyhopShim = skyhopAppShim({json.dumps(files())}, window.SkyhopNative);
  (function (chrome) {{
{(EXT / "background.js").read_text()}
  }}).call(window, window.SkyhopShim.background);
  const page = () => (function (chrome) {{
{(EXT / "content-bridge.js").read_text()}
  }}).call(window, window.SkyhopShim.content);
  if (document.documentElement) page(); else document.addEventListener("readystatechange", page, {{ once: true }});
}})();
"""


def build(out: Path = OUT) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(bundle())
    return out


if __name__ == "__main__":
    print(build(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT))
