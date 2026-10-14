"""The whole page in Hebrew: translation table coverage, RTL, and a real search on screen."""
import json
import re
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parent.parent / "src" / "flightagent" / "web"
TOUR_SEEN = "try { localStorage.setItem('skyhop.tour', JSON.stringify('seen')) } catch (e) {}"


def _he_table():
    out = subprocess.run(["node", "-e", f"global.window={{}};require('{WEB}/i18n-he.js');console.log(JSON.stringify(window.SKYHOP_HE))"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_every_translated_word_keeps_its_placeholders():
    he = _he_table()
    slots = lambda s: set(re.findall(r"\{\w+\}", s))
    bad = [k for k, v in he["words"].items() if not slots(v) <= slots(k)]   # "one child" may drop {n}; a Hebrew-only slot is a typo
    assert not bad, f"Hebrew uses a {{slot}} the English lacks: {bad[:5]}"
    assert all(len(v) == 2 and all(v) for v in he["plural"].values()), "each plural has a singular and a plural form"


def test_every_static_label_in_index_html_has_a_hebrew_translation():
    he = _he_table()["words"]
    html = (WEB / "index.html").read_text()
    labels = {m.replace("&amp;", "&").strip() for m in re.findall(r">([^<>{}]*[A-Za-z]{3,}[^<>{}]*)<", html)} - {"Skyhop"}
    labels = {l for l in labels if not re.match(r"^\W?\s?(USD|GBP|ILS|EUR)$", l)}   # currency codes are the same in Hebrew
    missing = sorted(l for l in labels if l not in he and not l.startswith(("//", "http")))
    assert not missing, f"index.html text without a Hebrew entry: {missing[:8]}"


@pytest.fixture
def hebrew(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_context(locale="he-IL", viewport={"width": 1400, "height": 900}).new_page()
        pg.add_init_script(TOUR_SEEN)
        pg.goto(base_url + "/")
        pg.wait_for_function("typeof readForm === 'function' && !!ac.from")
        yield pg
        b.close()


def test_a_hebrew_browser_gets_a_right_to_left_hebrew_page(hebrew):
    root = hebrew.locator("html")
    assert root.get_attribute("lang") == "he" and root.get_attribute("dir") == "rtl"
    assert hebrew.inner_text("#go").startswith("חיפוש טיסות")
    assert hebrew.get_attribute("#to-in", "placeholder").startswith("רומא")


def test_a_hebrew_search_shows_hebrew_results_with_nothing_overflowing(hebrew):
    hebrew.evaluate("""() => { const f = readForm(); f.to = ['ROM', 'PAR']; f.start = '2026-11-02'; f.end = '2026-11-24';
                        f.lenMode = 'range'; f.nmin = 3; f.nmax = 5; writeForm(f); onFormChange(); }""")
    hebrew.wait_for_function("!document.querySelector('#go').disabled")
    hebrew.click("#go")
    hebrew.wait_for_selector(".res-head")
    text = hebrew.inner_text("#results")
    assert "לילות" in text and "עצירות" in text or "ישיר" in text
    assert not re.search(r"\b\d+ nights?\b|\bstops?\b", text), "no English units left in the results"
    assert hebrew.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "RTL must not add a horizontal scrollbar"


def test_the_language_switch_reloads_in_english_and_back(hebrew):
    hebrew.click(".main-head .help-btn")
    hebrew.click(".help .help-lang [lang=en]")
    hebrew.wait_for_function("document.documentElement.dir !== 'rtl' && typeof readForm === 'function' && !!ac.from")
    assert hebrew.inner_text("#go").startswith("Find flights")
