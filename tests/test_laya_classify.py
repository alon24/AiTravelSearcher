import httpx
import pytest

from flightagent.providers import laya_classify as lc


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("FLIGHTAGENT_LAYA", raising=False)
    monkeypatch.delenv("FLIGHTAGENT_LAYA_URL", raising=False)


def _fake_post(choice=None, raise_transport_error=False, http_status=200):
    """Stub httpx.post so tests never need a running laya-service."""

    def post(url, json, timeout, headers=None):
        if raise_transport_error:
            raise httpx.ConnectError("connection refused")
        body = {"model": "laya-rl-agent", "answers": {
            "page_type": {"type": "choice", "choice": choice, "confidence": 0.9},
        }, "usage": {"input_tokens": 1, "output_tokens": 0}}
        request = httpx.Request("POST", url)
        return httpx.Response(http_status, json=body, request=request)

    return post


def test_disabled_by_default_returns_none(monkeypatch):
    monkeypatch.setattr(httpx, "post", _fake_post(choice="consent"))  # even if reachable, default (unset) is off
    assert lc.classify_page("some page text") is None
    assert lc.diagnose("some page text") == "consent page, block or layout change"


def test_classifies_when_enabled(monkeypatch):
    monkeypatch.setenv("FLIGHTAGENT_LAYA", "1")
    monkeypatch.setattr(httpx, "post", _fake_post(choice="captcha"))
    assert lc.classify_page("please verify you are human") == "captcha"
    assert lc.diagnose("please verify you are human") == "CAPTCHA / bot check"


def test_service_unreachable_falls_back_to_none(monkeypatch):
    monkeypatch.setenv("FLIGHTAGENT_LAYA", "1")
    monkeypatch.setattr(httpx, "post", _fake_post(raise_transport_error=True))
    assert lc.classify_page("anything") is None
    assert lc.diagnose("anything") == "consent page, block or layout change"


def test_service_error_status_falls_back_to_none(monkeypatch):
    monkeypatch.setenv("FLIGHTAGENT_LAYA", "1")
    monkeypatch.setattr(httpx, "post", _fake_post(http_status=500))
    assert lc.classify_page("anything") is None


def test_uses_configured_url(monkeypatch):
    monkeypatch.setenv("FLIGHTAGENT_LAYA", "1")
    monkeypatch.setenv("FLIGHTAGENT_LAYA_URL", "http://example.internal:9000")
    seen = {}

    def post(url, json, timeout, headers=None):
        seen["url"] = url
        body = {"answers": {"page_type": {"choice": "blocked"}}}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", post)
    lc.classify_page("anything")
    assert seen["url"] == "http://example.internal:9000/classify"
