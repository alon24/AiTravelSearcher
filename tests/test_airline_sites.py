import httpx
import pytest
from fastapi.testclient import TestClient

from flightagent import airline_sites as a
from flightagent.api import app


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "offers.sqlite"))
    monkeypatch.setattr(a, "_mem", {})
    monkeypatch.setattr(a, "_loaded", False)
    monkeypatch.setattr(a, "public_https_url", lambda u: u.replace("http://", "https://"))    # no DNS in tests
    monkeypatch.setattr(a, "site_answers", lambda u, timeout=8.0: True)


def rows(*pairs, by_code=0):
    return [{"aLabel": {"value": lab}, "site": {"value": url}, "byCode": {"value": str(by_code)}} for lab, url in pairs]


def test_a_listed_airline_needs_no_lookup(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: pytest.fail("Wikidata must not be asked for an airline we already list"))
    assert a.resolve("W6", "Wizz Air") == {"url": "https://wizzair.com", "source": "list"}


def test_an_unknown_airline_is_found_with_one_query_by_code_or_name(monkeypatch):
    calls = []
    def q(sparql, timeout=20.0):
        calls.append(sparql)
        return rows(("Animawings", "https://www.animawings.com/"))
    monkeypatch.setattr(a, "_query", q)
    assert a.resolve("ZQ", "Animawings") == {"url": "https://www.animawings.com/", "source": "wikidata"}
    assert len(calls) == 1                                                                # code and name in one query: half the load on a shared service
    assert 'P229 "ZQ"' in calls[0] and 'rdfs:label "Animawings"@en' in calls[0]
    assert 'FILTER NOT EXISTS { ?a wdt:P576 ?e }' in calls[0]                             # a dissolved airline that once had the code is not it


def test_a_row_found_by_iata_code_beats_one_found_by_name(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Zed Air", "https://by-name.example/"), by_code=0) + rows(("Zed Airlines", "https://by-code.example/"), by_code=1))
    assert a.resolve("ZQ", "Zed Air")["url"] == "https://by-code.example/"


def test_the_row_whose_name_matches_wins(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Old Carrier", "https://old.example/"), ("Tus Airways", "https://tusairways.com/")))
    assert a.resolve("U9", "Tus Air")["url"] == "https://tusairways.com/"


def test_a_matching_code_alone_is_not_enough_the_name_must_agree(monkeypatch):
    # XZ belongs to Aeroitalia; asking for "Ryanair" with that code must not send you to Aeroitalia's site.
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Aeroitalia", "https://www.aeroitalia.com/"), by_code=1))
    assert a.resolve("XZ", "Ryanair")["url"] is None
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Aeroitalia", "https://www.aeroitalia.com/"), by_code=1))
    assert a.resolve("XZ", "Aeroitalia srl")["url"] == "https://www.aeroitalia.com/"     # same code, agreeing name: fine


@pytest.mark.parametrize("google_name,wikidata_label", [("ITA", "ITA Airways"), ("Wizz Air", "Wizz Air Hungary"), ("El Al", "El Al Israel Airlines"), ("Jet2", "Jet2.com"),
                                                          ("Tus Air", "Tus Airways"), ("Israir Airlines", "Israir"), ("Animawings", "Animawings")])
def test_real_world_naming_differences_still_match(monkeypatch, google_name, wikidata_label):
    monkeypatch.setattr(a, "_query", lambda *_: rows((wikidata_label, "https://ok.example/"), by_code=1))
    assert a.resolve("ZQ", google_name)["url"] == "https://ok.example/"


def test_answers_are_cached_and_misses_too(monkeypatch):
    n = []
    monkeypatch.setattr(a, "_query", lambda *_: (n.append(1), rows(("Zed Air", "https://zed.example/")))[1])
    assert a.resolve("ZZ", "Zed Air")["source"] == "wikidata"
    assert a.resolve("ZZ", "Zed Air") == {"url": "https://zed.example/", "source": "cache"}
    assert len(n) == 1
    monkeypatch.setattr(a, "_query", lambda *_: (n.append(1), [])[1])
    assert a.resolve("QQ", "Nobody Air") == {"url": None, "source": None}
    a.resolve("QQ", "Nobody Air")
    assert len(n) == 2                                                                    # a real "no website" was remembered: no third lookup
    assert a.cache_path().exists()                                                        # ...and persisted next to the price cache


def test_no_site_means_none_never_a_guess(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: [])
    assert a.resolve("ZZ", "Nobody Air")["url"] is None


def test_a_site_that_does_not_answer_is_not_used(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Ghost Air", "https://ghost.example/")))
    monkeypatch.setattr(a, "site_answers", lambda u, timeout=8.0: False)
    assert a.resolve("GG", "Ghost Air")["url"] is None


def test_wikidata_being_down_is_reported_as_unavailable_not_as_no_website(monkeypatch):
    def boom(*_):
        raise a.Unavailable("429")
    monkeypatch.setattr(a, "_query", boom)
    assert a.resolve("ZZ", "Zed Air") == {"url": None, "source": None, "unavailable": True}
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Zed Air", "https://zed.example/")))
    assert a.resolve("ZZ", "Zed Air")["url"] == "https://zed.example/"                    # asked again: the outage was not cached


def test_a_429_makes_us_back_off_instead_of_hammering(monkeypatch):
    calls = []
    class R:
        status_code = 429
        headers = {"Retry-After": "30"}
    monkeypatch.setattr(a.httpx, "get", lambda *x, **k: (calls.append(1), R())[1])
    monkeypatch.setattr(a, "_blocked_until", 0.0)
    monkeypatch.setattr(a, "_last_query", 0.0)
    monkeypatch.setattr(a, "MIN_GAP", 0.0)
    with pytest.raises(a.Unavailable):
        a._query("SELECT 1")
    with pytest.raises(a.Unavailable):
        a._query("SELECT 1")
    assert len(calls) == 1                                                                # the second call never left the building
    assert a._blocked_until > 0
    R.headers = {"Retry-After": "1000"}
    monkeypatch.setattr(a, "_blocked_until", 0.0)
    with pytest.raises(a.Unavailable):
        a._query("SELECT 1")
    import time
    assert 900 < a._blocked_until - time.time() <= 1001                                     # the full 1000 s is honoured, not shortened


@pytest.mark.parametrize("code,name", [("", 'x" } UNION { ?s ?p ?o'), ("a b", "x\\"), ("", ""), ("", "<script>"), ("TOOLONG", "")])
def test_odd_input_never_reaches_wikidata(monkeypatch, code, name):
    monkeypatch.setattr(a, "_query", lambda *_: pytest.fail("must not query"))
    assert a.resolve(code, name)["url"] is None


def test_only_public_https_addresses_are_accepted():
    from importlib import reload
    reload(a)                                                                              # undo the test stub
    for bad in ("http://localhost/", "https://127.0.0.1/", "https://10.0.0.5/x", "https://n8n:5678/", "https://user:pw@example.com/", "ftp://example.com/", "javascript:alert(1)", "https://flightagent/"):
        assert a.public_https_url(bad) is None, bad


def test_endpoint_needs_the_skyhop_header_and_returns_the_resolution(monkeypatch):
    monkeypatch.setattr(a, "_query", lambda *_: rows(("Animawings", "https://www.animawings.com/")))
    c = TestClient(app)
    assert c.get("/api/airline-site?code=ZQ&name=Animawings").status_code == 403
    r = c.get("/api/airline-site?code=ZQ&name=Animawings", headers={"X-Skyhop": "1"})
    assert r.status_code == 200 and r.json() == {"url": "https://www.animawings.com/", "source": "wikidata"}
