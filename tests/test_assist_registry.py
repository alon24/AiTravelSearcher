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
CONFIG = json.loads((ROOT / "src/flightagent/data/config.json").read_text())
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
    assert r["l"]["bound"] is False


def test_a_template_with_an_internal_id_is_bound_to_its_destination():
    pw, code = _js()
    israir = ('https://www.israir.co.il/reservation/search/flights-abroad/results?origin={"type":"ltravelid","cityCode":"TLV","ltravelid":2135}'
              '&destination={"type":"ltravelid","cityCode":"ROM","ltravelid":2196}&date=2026-10-02&adults=1')
    with pw.sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto("about:blank")
        r = pg.evaluate(LEARN, [code, israir, {**D, "day": "2026-10-02"}])
        b.close()
    assert r["l"]["bound"] is True
    assert "{destcity}" in r["l"]["url"] and "{origin}" in r["l"]["url"]


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


# ---- drivers/parse.js: prices, digits, times and "select" words in the languages Skyhop meets ----

def _parse_page(pw):
    p = pw.sync_playwright().start()
    b = p.chromium.launch()
    pg = b.new_page()
    pg.goto("about:blank")
    pg.add_script_tag(content=(EXT / "drivers" / "parse.js").read_text())
    return p, b, pg


@pytest.mark.parametrize("text,expected", [
    ("€ 113.24", 113.24), ("$90 לנוסע", 90.0), ("113,24 €", 113.24), ("1.234,56 €", 1234.56), ("RON 1,299.00", 1299.0),
    ("7 500 ₽", 7500.0), ("45,99 lei", 45.99), ("٩٠ $", 90.0), ("EUR 55.99", 55.99), ("Price per person", None),
    ("Prix par personne", None), ("03:55 | Non stop", None), ("1,299 €", 1299.0),
])
def test_parse_prices(text, expected):
    pw = pytest.importorskip("playwright.sync_api")
    p, b, pg = _parse_page(pw)
    try:
        assert pg.evaluate("t => window.__skyhopParse.priceIn(t)", text) == expected
    finally:
        b.close()
        p.stop()


@pytest.mark.parametrize("text,expected", [
    ("2:30 PM", ["14:30"]), ("2:30pm", ["14:30"]), ("11:45 p.m.", ["23:45"]), ("12:05 AM", ["00:05"]), ("12:30 PM", ["12:30"]),
    ("7:05AM", ["07:05"]), ("Dep 7:05 AM  Arr 1:20 PM", ["07:05", "13:20"]), ("16:40 -> 19:25", ["16:40", "19:25"]),
    ("3:55 | Non stop", []), ("13:00 PM", []), ("0:30 AM", []), ("12:30:45", []), ("9:15 a.m. to 11:50 a.m.", ["09:15", "11:50"]),
])
def test_parse_12_and_24_hour_times(text, expected):
    pw = pytest.importorskip("playwright.sync_api")
    p, b, pg = _parse_page(pw)
    try:
        assert pg.evaluate("t => window.__skyhopParse.timesIn(t)", text) == expected
    finally:
        b.close()
        p.stop()


def test_parse_times_including_arabic_digits():
    pw = pytest.importorskip("playwright.sync_api")
    p, b, pg = _parse_page(pw)
    try:
        assert pg.evaluate("t => window.__skyhopParse.timesIn(t)", "16:40 تل أبيب ... ١٩:٢٥ روما") == ["16:40", "19:25"]
    finally:
        b.close()
        p.stop()


@pytest.mark.parametrize("label,is_select", [
    ("Select", True), ("SELECT", True), ("Choose", True), ("Sélectionner", True), ("Choisir", True), ("Réserver", True),
    ("Auswählen", True), ("Wählen", True), ("Buchen", True), ("Alege", True), ("Selectează", True), ("Rezervă", True),
    ("Выбрать", True), ("Выбор", True), ("Забронировать", True), ("اختيار", True), ("اختر", True), ("احجز", True),
    ("בחירה", True), ("Seleccionar", True), ("Seç", True),
    ("Price per person", False), ("Prix par personne", False), ("Preis pro Person", False), ("Preț pe persoană", False),
    ("Цена за человека", False), ("السعر للشخص", False), ("פרטי טיסה", False), ("?", False), ("Details", False),
])
def test_select_words(label, is_select):
    pw = pytest.importorskip("playwright.sync_api")
    p, b, pg = _parse_page(pw)
    try:
        assert pg.evaluate("t => window.__skyhopParse.SELECT_WORD.test(t)", label) == is_select
    finally:
        b.close()
        p.stop()


def test_phone_search_links_are_the_verified_templates():
    """config.json's airline_search_urls (what a phone opens without the extension) = the registry's verified url templates."""
    AIRLINE_SEARCH_URLS = CONFIG["airline_search_urls"]

    want = {c: a["url"] for key, a in REG.items() if a["mode"] == "url" and a["status"] == "verified" for c in [key, *a["aliases"]]}
    assert AIRLINE_SEARCH_URLS == want
