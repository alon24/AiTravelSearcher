"""The Cloudflare Worker (worker/) that holds the API keys for the GitHub Pages build. Its own tests are JavaScript
(worker/test/, `node --test`); running them here keeps them in the one suite CI runs. Skipped without Node."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from flightagent.providers.airports import CITY_AIRPORTS

WORKER = Path(__file__).resolve().parent.parent / "worker"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")


def test_worker_tests_pass():
    out = subprocess.run(["node", "--test"], cwd=WORKER, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stdout[-4000:] + out.stderr[-2000:]


def test_worker_expands_city_codes_like_the_python_provider():
    src = "import('./src/index.js').then(m => process.stdout.write(JSON.stringify(m.CITY_AIRPORTS)))"
    out = subprocess.run(["node", "--input-type=module", "-e", src], cwd=WORKER, capture_output=True, text=True, timeout=60, check=True)
    assert json.loads(out.stdout) == CITY_AIRPORTS


@pytest.mark.parametrize("pax, stops, bags, dest", [((1, 0, 0), 1, (0, 0), "FCO"), ((2, 1, 1), 0, (0, 1), "ROM"),
                                                    ((3, 2, 0), 3, (1, 2), "IST")])
def test_worker_builds_the_same_google_flights_query_as_the_python_provider(pax, stops, bags, dest):
    from flightagent.providers.gflights import tfs

    args = {"origin": "TLV", "dest": dest, "day": "2026-11-02", "adults": pax[0], "children": pax[1], "infants": pax[2],
            "maxStops": stops, "carryOn": bags[0], "checked": bags[1]}
    src = f"import('./src/gflights.js').then(m => process.stdout.write(m.tfs({json.dumps(args)})))"
    out = subprocess.run(["node", "--input-type=module", "-e", src], cwd=WORKER, capture_output=True, text=True, timeout=60, check=True)
    assert out.stdout == tfs("TLV", dest, "2026-11-02", *pax, stops, *bags)
