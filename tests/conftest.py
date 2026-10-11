"""Shared fixtures for tests that drive the real web page in Chromium (skipped when Playwright is not installed)."""
import socket
import threading
import time

import pytest


def pytest_generate_tests(metafunc):
    """Tests marked `docker` also run against the Python service (the Docker version); the rest only on the Pages
    build, which is what people use and shares the same page code (ilan, 2026-10-11: cut the duplicate runs)."""
    if "base_url" in metafunc.fixturenames and metafunc.definition.get_closest_marker("docker"):
        metafunc.parametrize("base_url", ["server", "browser"], indirect=True, scope="session")


@pytest.fixture(scope="session")
def base_url(request, tmp_path_factory):
    """The GitHub Pages build (no server: the /api routes are answered inside the page by web/local/backend.js),
    served under a sub-path as Pages does; or, for `docker` tests, also the Python service."""
    pytest.importorskip("playwright.sync_api")
    if getattr(request, "param", "browser") == "browser":
        yield from _static_site(tmp_path_factory)
        return
    uvicorn = pytest.importorskip("uvicorn")
    import os
    os.environ["FLIGHTAGENT_PROVIDER"] = "mock"
    os.environ["FLIGHTAGENT_CACHE_DB"] = str(tmp_path_factory.mktemp("db") / "offers.sqlite")
    os.environ["FLIGHTAGENT_RECHECK"] = "0"
    from flightagent.api import app
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True); t.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=5)


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
        pg.goto(base_url + "/")
        pg.evaluate("localStorage.clear()")
        pg.reload()
        pg.wait_for_function("typeof readForm === 'function' && !!ac.from")
        yield pg
        b.close()
