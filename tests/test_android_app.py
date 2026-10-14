"""The Skyhop Android app (android/): the Airline Assist extension's own scripts run in the app's Skyhop page on
android/web/app-shim.js, and the airline's site is the app's second tab. The Java side is only compiled in CI
(.github/workflows/android.yml); the page side is driven in tests/test_android_app_ui.py."""
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from build_android import bundle, files  # noqa: E402

JAVA = (ROOT / "android/app/src/main/java/io/github/alon24/skyhop/MainActivity.java").read_text()


def test_the_app_runs_the_extension_scripts_unchanged():
    js = bundle()
    for f in ("background.js", "content-bridge.js"):
        assert (ROOT / "browser-extension" / f).read_text() in js
    background = (ROOT / "browser-extension/background.js").read_text()
    named = set(re.findall(r'"(drivers/[\w-]+\.js)"', background)) | {"airlines.json"}
    assert named and named <= set(files()), "every file background.js injects or fetches is in the app"


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_the_bundle_is_valid_javascript(tmp_path):
    out = tmp_path / "skyhop-app.js"
    out.write_text(bundle())
    subprocess.run(["node", "--check", str(out)], check=True)


def test_the_java_bridge_has_every_call_the_scripts_make():
    """The APK is only compiled in CI, so check here that both sides name the same calls."""
    shim = (ROOT / "android/web/app-shim.js").read_text() + (ROOT / "src/flightagent/web/local/account.js").read_text()
    used = set(re.findall(r"native\.(\w+)\(", shim)) | set(re.findall(r"SkyhopNative\.(\w+)\(", shim))
    exposed = set(re.findall(r"@JavascriptInterface\s+public \w+ (\w+)\(", JAVA))
    assert used and used <= exposed, f"missing in MainActivity.java: {used - exposed}"
    assert "SkyhopAirline.send(" in (ROOT / "android/web/airline-bridge.js").read_text() and "public void send(" in JAVA
    for call in ("SkyhopShim.done(", "SkyhopShim.fromAirline(", "__skyhopBridge.reply("):
        assert call in JAVA



def test_the_app_knows_the_commit_it_was_built_from(monkeypatch):
    """The page compares this with the newest APK's release notes to say when the phone's app is out of date."""
    monkeypatch.setenv("GITHUB_SHA", "0123456789abcdef")
    assert 'window.SKYHOP_BUILD = "0123456";' in bundle()
