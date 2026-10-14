"""Shared fixtures for tests that drive the real web page in Chromium (skipped when Playwright is not installed)."""
import threading

import pytest

# Marks the welcome tour (web/help.js) as already shown, so it doesn't open over the page under test.
TOUR_SEEN = "try { localStorage.setItem('skyhop.tour', JSON.stringify('seen')) } catch (e) {}"


@pytest.fixture(scope="session")
def base_url(tmp_path_factory):
    """The GitHub Pages build (the /api routes are answered inside the page by web/local/backend.js), served under a
    sub-path as Pages does."""
    pytest.importorskip("playwright.sync_api")
    yield from _static_site(tmp_path_factory)


def _static_site(tmp_path_factory):
    import functools
    import sys
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    from build_pages import build
    root = tmp_path_factory.mktemp("pages")
    build(root / "skyhop")

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    t = threading.Thread(target=server.serve_forever, daemon=True); t.start()
    yield f"http://127.0.0.1:{server.server_port}/skyhop"
    server.shutdown()


@pytest.fixture
def page(base_url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        pg.add_init_script(TOUR_SEEN)   # the first-visit tour would cover the page; test_help_ui.py covers it
        pg.goto(base_url + "/")
        pg.evaluate("localStorage.clear()")
        pg.reload()
        pg.wait_for_function("typeof readForm === 'function' && !!ac.from")
        yield pg
        b.close()
