"""Guards for the browser extension's airline registry (browser-extension/airlines.json) -- data only, no browser
needed -- plus the URL-template learning logic in background.js, which runs in Chromium if Playwright is installed."""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "browser-extension"
REG = json.loads((EXT / "airlines.json").read_text())["airlines"]
MODES = {"url", "bespoke", "discover"}
STATUSES = {"verified", "bespoke", "discover"}


def test_codes_and_aliases_are_unique():
    seen = {}
    for key, a in REG.items():
        for code in [key, *a["aliases"]]:
            assert code not in seen, f"{code} is used by both {seen[code]} and {key}"
            seen[code] = key


@pytest.mark.parametrize("key", sorted(REG))
def test_entry_is_well_formed(key):
    a = REG[key]
    assert a["mode"] in MODES and a["status"] in STATUSES
    assert a["name"] and a["hosts"] and all(re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", h) for h in a["hosts"])
    if a["mode"] == "url":
        assert a["status"] == "verified"
        for ph in ("{origin}", "{dest}", "{date"):
            assert ph in a["url"], f"{key}: template lacks {ph}"
        host = urlparse(a["url"]).hostname
        assert any(host == h or host.endswith("." + h) for h in a["hosts"]), f"{key}: template host not in hosts"
        assert a["match"] in a["url"].replace("https://", "")
    if a["mode"] == "discover":
        assert a["status"] == "discover" and "url" not in a
    if a["mode"] == "bespoke":
        assert a["status"] == "bespoke"


def test_manifest_hosts_are_generated_from_the_registry():
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "sync_assist_manifest.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def _js():
    pw = pytest.importorskip("playwright.sync_api")
    src = (EXT / "background.js").read_text()
    code = src[src.index("const DATE_PATTERNS"):src.index("// Laya service calls")]
    return pw, code


LEARN = "([c,u,d])=>{const f=new Function(c+';return {learnFrom,fill}')();const l=f.learnFrom(u,d);return {l, back:(l&&l.url)?f.fill(l.url,d):null}}"
D = {"origin": "TLV", "destination": "FCO", "destCodes": ["FCO", "ROM"], "destCity": "ROM", "day": "2026-10-23"}


@pytest.mark.parametrize("url,expect_template", [
    ("https://www.wizzair.com/en-gb/booking/select-flight/TLV/FCO/2026-10-23/null/1/0/0/null",
     "https://www.wizzair.com/en-gb/booking/select-flight/{origin}/{dest}/{date:YYYY-MM-DD}/null/1/0/0/null"),
    ("https://x.example.com/fly/TLV-FCO/23102026/1", "https://x.example.com/fly/{origin}-{dest}/{date:DDMMYYYY}/1"),
    ("https://x.example.com/search/TLV/ROM/2026-10-23", "https://x.example.com/search/{origin}/{destcity}/{date:YYYY-MM-DD}"),
    ("https://x.example.com/r?from=tlv&to=fco&d=23.10.2026", "https://x.example.com/r?from={origin:l}&to={dest:l}&d={date:DD.MM.YYYY}"),
])
def test_learns_a_template_and_replays_it(url, expect_template):
    pw, code = _js()
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto("about:blank")
        r = pg.evaluate(LEARN, [code, url, D])
        b.close()
    assert r["l"]["url"] == expect_template
    assert r["back"] == url


@pytest.mark.parametrize("url,rejected", [
    ("https://www.x.com/en/", False),                                   # home page: nothing to learn yet
    ("https://x.example.com/r?to=FCO&d=2026-11-01", False),             # right airport, wrong date
    ("https://x.example.com/r?sid=abcdEFGH1234abcdEFGH1234abcd&to=FCO&d=2026-10-23", True),  # session token
])
def test_does_not_learn_from_the_wrong_page(url, rejected):
    pw, code = _js()
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto("about:blank")
        r = pg.evaluate(LEARN, [code, url, D])
        b.close()
    assert (r["l"] is not None and "rejected" in r["l"]) == rejected
    assert not (r["l"] and r["l"].get("url"))
