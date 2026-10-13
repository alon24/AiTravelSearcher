"""The Cloudflare Worker (worker/) that holds the API keys for the GitHub Pages build. Its own tests are JavaScript
(worker/test/, `node --test`); running them here keeps them in the one suite CI runs. Skipped without Node."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

WORKER = Path(__file__).resolve().parent.parent / "worker"
CONFIG = json.loads((WORKER.parent / "src/flightagent/data/config.json").read_text())
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")


def test_worker_tests_pass():
    out = subprocess.run(["node", "--test"], cwd=WORKER, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stdout[-4000:] + out.stderr[-2000:]


def test_worker_expands_city_codes_like_the_page():
    src = "import('./src/index.js').then(m => process.stdout.write(JSON.stringify(m.CITY_AIRPORTS)))"
    out = subprocess.run(["node", "--input-type=module", "-e", src], cwd=WORKER, capture_output=True, text=True, timeout=60, check=True)
    assert json.loads(out.stdout) == CONFIG["city_airports"]


@pytest.mark.parametrize("pax, stops, bags, dest, back, want", [
    ((1, 0, 0), 1, (0, 0), "FCO", None, "GiASCjIwMjYtMTEtMDIoAWoHCAESA1RMVnIHCAESA0ZDT0IBAUgBmAEC"),
    ((2, 1, 1), 0, (0, 1), "ROM", None, "Gh4SCjIwMjYtMTEtMDIoAGoHCAESA1RMVnIFEgNST01CBAEBAgNIAWoEEAAYAZgBAg=="),
    ((3, 2, 0), 3, (1, 2), "IST", None, "Gh4SCjIwMjYtMTEtMDJqBwgBEgNUTFZyBwgBEgNJU1RCBQEBAQICSAFqBBABGAKYAQI="),
    ((2, 1, 0), 1, (0, 1), "FCO", "2026-11-09",
     "GiASCjIwMjYtMTEtMDIoAWoHCAESA1RMVnIHCAESA0ZDTxogEgoyMDI2LTExLTA5KAFqBwgBEgNGQ09yBwgBEgNUTFZCAwEBAkgBagQQABgBmAEB"),
])
def test_worker_builds_the_google_flights_query(pax, stops, bags, dest, back, want):
    """The expected queries were made by the retired Python scraper (providers/gflights.py), which Google answered."""
    args = {"origin": "TLV", "dest": dest, "day": "2026-11-02", "adults": pax[0], "children": pax[1], "infants": pax[2],
            "maxStops": stops, "carryOn": bags[0], "checked": bags[1], "returnDay": back}
    src = f"import('./src/gflights.js').then(m => process.stdout.write(m.tfs({json.dumps(args)})))"
    out = subprocess.run(["node", "--input-type=module", "-e", src], cwd=WORKER, capture_output=True, text=True, timeout=60, check=True)
    assert out.stdout == want
