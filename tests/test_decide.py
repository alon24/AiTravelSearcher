import httpx
import pytest
from fastapi.testclient import TestClient

from flightagent import decide
from flightagent.api import app

Q = {"q": {"type": "noul", "instructions": "Is this page element the button that declines cookies?"}}
GOOD = {"id": "gen-dec-1", "model": "typesafe/jev-1.13-20260917", "answers": {"q": {"type": "noul", "noul": 0.93}},
        "usage": {"input_tokens": 60, "output_tokens": 3, "cost": 0.0000025}}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("OPENROUTER_API_KEY", "OPENROUTER_KEY", "FLIGHTAGENT_JEV_MODEL", "FLIGHTAGENT_DECIDER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(decide, "_spent", 0.0)
    monkeypatch.setattr(decide, "_calls", 0)


def _post(monkeypatch, status=200, body=None, capture=None):
    def post(url, json, timeout, headers):
        if capture is not None:
            capture.update(url=url, json=json, headers=headers)
        return httpx.Response(status, json=body if body is not None else GOOD, request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", post)


def test_request_is_adapted_for_jev(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "sk-or-test")
    seen = {}
    _post(monkeypatch, capture=seen)
    out = decide.decide_jev("Page element: button \"Deny all\"", Q)
    assert out["answers"]["q"]["noul"] == 0.93 and out["cost"] == pytest.approx(0.0000025)
    assert seen["url"] == "https://openrouter.ai/api/alpha/decisions"
    assert seen["headers"]["Authorization"] == "Bearer sk-or-test"
    body = seen["json"]
    assert body["model"] == "typesafe/jev-1.13"
    assert body["state"] == {"text": "Page element: button \"Deny all\""}      # a bare string is wrapped in an object
    assert body["questions"]["q"]["criteria"] == {"true": "Yes, the statement holds.", "false": "No, the statement does not hold."}
    assert "criteria" not in Q["q"]                                            # the caller's dict is not mutated


def test_model_and_key_come_from_env(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-a")
    monkeypatch.setenv("OPENROUTER_KEY", "sk-or-b")
    monkeypatch.setenv("FLIGHTAGENT_JEV_MODEL", "~typesafe/jev-latest")
    seen = {}
    _post(monkeypatch, capture=seen)
    decide.decide_jev({"a": 1}, Q)
    assert seen["headers"]["Authorization"] == "Bearer sk-or-a" and seen["json"]["model"] == "~typesafe/jev-latest"
    assert seen["json"]["state"] == {"a": 1}


def test_cost_is_summed(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    _post(monkeypatch)
    decide.decide_jev("x", Q)
    decide.decide_jev("y", Q)
    assert decide.spent_usd() == {"calls": 2, "usd": pytest.approx(0.000005)}


def test_no_key_is_an_actionable_error():
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        decide.decide_jev("x", Q)


def test_http_error_is_terse_and_never_contains_the_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "sk-or-SECRET")
    _post(monkeypatch, status=401, body={"error": "bad key"})
    with pytest.raises(RuntimeError) as e:
        decide.decide_jev("x", Q)
    assert "401" in str(e.value) and "sk-or-SECRET" not in str(e.value)


def test_limits(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    with pytest.raises(ValueError):
        decide.to_jev_request("x" * (decide.MAX_STATE_CHARS + 1), Q)
    with pytest.raises(ValueError):
        decide.to_jev_request("x", {str(i): Q["q"] for i in range(decide.MAX_QUESTIONS + 1)})


# ---- the /api/decide endpoint the extension calls ----

def test_endpoint_requires_the_skyhop_header(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    _post(monkeypatch)
    c = TestClient(app)
    assert c.post("/api/decide", json={"state": "x", "questions": Q}).status_code == 403
    assert c.get("/api/decide/health").status_code == 403
    r = c.post("/api/decide", json={"state": "x", "questions": Q}, headers={"X-Skyhop": "1"})
    assert r.status_code == 200 and r.json()["backend"] == "jev" and r.json()["answers"]["q"]["noul"] == 0.93


def test_endpoint_reports_configuration_and_maps_errors(monkeypatch):
    c = TestClient(app)
    h = {"X-Skyhop": "1"}
    assert c.get("/api/decide/health", headers=h).json()["jev_configured"] is False
    assert c.post("/api/decide", json={"state": "x", "questions": Q}, headers=h).status_code == 502    # no key
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    assert c.get("/api/decide/health", headers=h).json()["jev_configured"] is True
    assert c.post("/api/decide", json={"state": "x" * 20000, "questions": Q}, headers=h).status_code == 422
