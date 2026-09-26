"""Search form layout (docs/stitch/DESIGN.md): the five fields on one row with aligned labels, adults and children on their own row,
nothing wider than the window, and no false "length was set to fit" warning on a fresh page."""
import pytest

pytest.importorskip("playwright.sync_api")


def middle(page, sel):
    b = page.locator(sel).first.bounding_box()
    return b["y"] + b["height"] / 2


def test_five_fields_on_one_row_with_aligned_labels(page):
    labels = ["#form .row.dates > .field:nth-child(1) label", "#form .row.dates > .field:nth-child(2) label",
              "#form .row.dates > .field:nth-child(3) .lbl", "#form .row.dates > .field:nth-child(4) .lbl", "#form .row.dates > .field:nth-child(5) .lbl"]
    ys = [middle(page, s) for s in labels]      # centres: a label with a Nights/Days switch beside it is a taller box
    assert max(ys) - min(ys) <= 3                                                  # one line of labels
    xs = [page.locator(f"#form .row.dates > .field:nth-child({i})").bounding_box()["x"] for i in range(1, 6)]
    assert xs == sorted(xs) and len(set(round(x) for x in xs)) == 5                # five distinct columns, left to right
    assert page.locator("#form .row.dates > .field").count() == 5
    names = [t.strip().lower() for t in page.locator("#form .row.dates > .field").evaluate_all("els => els.map(e => e.querySelector('label, .lbl').textContent)")]
    assert [n.split("\n")[0] for n in names][:2] == ["earliest departure", "latest return"]
    for word in ("trip length", "stops", "currency"):
        assert any(word in n for n in names)


def test_labels_and_options_do_not_wrap(page):
    for sel in ("#form .row.dates .lbl", "#form .row.dates .seg label", "#form .row.dates > .field > label"):
        heights = page.locator(sel).evaluate_all("els => els.map(e => e.getBoundingClientRect().height)")
        assert heights and max(heights) < 46, (sel, heights)                       # a single line each


def test_adults_and_children_are_their_own_row_below(page):
    dates_bottom = page.locator("#form .row.dates").bounding_box()
    pax = page.locator("#form .row.pax").bounding_box()
    assert pax["y"] >= dates_bottom["y"] + dates_bottom["height"] - 1
    assert page.locator("#form .row.pax #adults").count() == 1 and page.locator("#form .row.pax #add-kid").count() == 1


@pytest.mark.parametrize("width", [1280, 1600, 2560])
def test_the_form_never_makes_the_page_wider_than_the_window(page, width):
    page.set_viewport_size({"width": width, "height": 1000})
    page.wait_for_timeout(300)
    assert page.evaluate("document.documentElement.scrollWidth") <= width + 1
    card = page.locator("#step-panel").bounding_box()
    assert card["x"] + card["width"] <= width + 1


def test_no_length_warning_on_a_fresh_page_in_simple_mode(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['ROM']; f.start = '2026-10-05'; f.end = '2026-10-25'; writeForm(f); onFormChange(); }""")
    page.wait_for_timeout(400)
    assert "set to fit" not in page.inner_text("#nights-hint")
    assert "20 nights" in page.inner_text("#len-any")
    # ...but in expert mode a length that cannot fit the dates is still explained
    page.check("#expert")
    page.fill("#nmin", "9"); page.dispatch_event("#nmin", "change")
    page.fill("#nmax", "30"); page.dispatch_event("#nmax", "change")
    assert "at most" in page.inner_text("#nights-hint")
