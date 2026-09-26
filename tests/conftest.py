"""Shared fixtures for tests that drive the real web page in Chromium (skipped when Playwright is not installed)."""
import socket
import threading
import time

import pytest


@pytest.fixture(scope="session")
def base_url(tmp_path_factory):
    pytest.importorskip("playwright.sync_api")
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
