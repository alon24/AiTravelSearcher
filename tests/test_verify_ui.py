"""Price verification on the results screen (docs/DESIGN.md section 8): no Verify buttons without a verifier; with one,
"Verify top 5" and per-trip "Verify" buttons, and a badge on each checked trip. Drives the real page in Chromium."""
import pytest

pytest.importorskip("playwright.sync_api")


@pytest.fixture
def second(monkeypatch):
    from flightagent import simple
    from flightagent.providers import MockProvider

    class Second(MockProvider):
        """Agrees with mock, except prices are scaled by `factor`."""
        name, factor = "second", 1.0

        async def one_way(self, o, d, day, **kw):
            return [x.model_copy(update={"price": round(x.price * self.factor, 2)}) for x in await super().one_way(o, d, day, **kw)]
    s = Second()
    real = simple._provider
    monkeypatch.setattr(simple, "_provider", lambda name: s if name == "second" else real(name))
    return s


def search(page, start):
    page.evaluate(f"""() => {{ const f = readForm(); f.to = ['ROM']; f.start = '{start}'; f.end = '2026-12-12';
                              f.lenMode = 'range'; f.nmin = 3; f.nmax = 4; writeForm(f); onFormChange(); }}""")
    page.wait_for_timeout(400)
    page.click("#go")
    page.wait_for_selector(".res-head", timeout=60000)


def test_no_verify_buttons_without_a_verifier(page, monkeypatch):
    monkeypatch.delenv("FLIGHTAGENT_VERIFIER", raising=False)
    page.reload(); page.wait_for_function("typeof readForm === 'function' && !!ac.from")
    search(page, "2026-12-01")
    assert page.locator("button:has-text('Verify')").count() == 0
    assert page.locator(".verify-badge").count() == 0


def test_verify_top_trips_shows_badges(page, monkeypatch, second):
    monkeypatch.setenv("FLIGHTAGENT_VERIFIER", "second")
    page.reload(); page.wait_for_function("typeof readForm === 'function' && config.verifier === 'second'")
    search(page, "2026-12-02")
    top = page.locator(".res-head button:has-text('Verify top')")
    assert top.count() == 1
    top.click()
    page.wait_for_selector(".verify-badge", timeout=30000)
    badges = page.locator(".verify-badge").all_inner_texts()
    assert badges and all(b == "✓ Verified by second" for b in badges)

    # the verifier now disagrees (and its cached answers have expired): a per-trip re-check says so, with both prices
    import os
    import sqlite3
    second.factor = 1.2
    with sqlite3.connect(os.environ["FLIGHTAGENT_CACHE_DB"]) as db:
        db.execute("DELETE FROM offers WHERE key LIKE '%|second|%'")
    card = page.locator(".card.trip:has(.verify-badge)").first
    card.locator("button:has-text('Verify on second')").click()
    page.wait_for_selector(".verify-badge:has-text('Price differs')", timeout=30000)
    text = page.locator(".verify-badge:has-text('Price differs')").first.inner_text()
    assert " vs " in text

