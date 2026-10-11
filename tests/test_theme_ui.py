"""Skyhop wears the suite's palette (MyMaps AI and Travel Hub: forest green on a pale green-grey), not neon purple, and every
text/background pair from its tokens stays readable (WCAG AA, 4.5:1) in both themes."""
import pytest

pytest.importorskip("playwright.sync_api")

PAIRS = [("--ink", "--bg"), ("--ink-2", "--card"), ("--muted", "--card"), ("--muted", "--bg"), ("--muted", "--card-2"),
         ("--accent", "--card"), ("--accent-2", "--card"), ("--accent-ink", "--accent-soft"), ("--on-accent", "--accent")]


def _luminance(hex_color):
    h = hex_color.strip().lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    r, g, b = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a, b):
    lo, hi = sorted([_luminance(a), _luminance(b)])
    return (hi + 0.05) / (lo + 0.05)


def _tokens(page, theme):
    page.evaluate(f"document.documentElement.dataset.theme = '{theme}'")
    return page.evaluate("""names => { const s = getComputedStyle(document.documentElement);
                                       return Object.fromEntries(names.map(n => [n, s.getPropertyValue(n).trim()])); }""",
                         sorted({n for pair in PAIRS for n in pair}))


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_token_pairs_are_readable(page, theme):
    t = _tokens(page, theme)
    low = {f"{fg} on {bg}": round(_contrast(t[fg], t[bg]), 2) for fg, bg in PAIRS if _contrast(t[fg], t[bg]) < 4.5}
    assert not low, low


def test_the_accent_is_the_suites_green_not_purple(page):
    assert _tokens(page, "light")["--accent"] == "#1f6f5c"
    go = page.evaluate("getComputedStyle(document.querySelector('#go')).backgroundImage")
    assert "rgb(31, 111, 92)" in go and "109, 74, 255" not in go
    assert page.evaluate("getComputedStyle(document.body).backgroundImage") == "none"   # no purple/pink glow behind the page
    assert page.locator("meta[name=theme-color]").get_attribute("content") == "#1f6f5c"


def test_text_on_solid_accent_flips_dark_in_dark_mode(page):
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_function("document.querySelector('#form').classList.contains('wz')")
    page.evaluate("document.body.insertAdjacentHTML('beforeend', '<div class=\"m-tabs\"><button aria-selected=\"true\">x</button></div>')")
    color = page.evaluate("getComputedStyle(document.querySelector('.m-tabs button')).color")
    assert color == "rgb(13, 26, 22)"   # --on-accent, readable on the light green; white would be 2.4:1
