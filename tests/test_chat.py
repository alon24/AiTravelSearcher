import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from flightagent import chat as chatmod
from flightagent.api import app


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setenv("FLIGHTAGENT_PROVIDER", "mock")
    monkeypatch.setenv("FLIGHTAGENT_CACHE_DB", str(tmp_path / "offers.sqlite"))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_KEY", raising=False)
    monkeypatch.setattr(chatmod, "_sessions", {})
    monkeypatch.setattr(chatmod, "_order", [])


def _resp(status=200, message=None):
    body = {"choices": [{"message": message}]} if message is not None else {"error": "boom"}
    return httpx.Response(status, json=body, request=httpx.Request("POST", chatmod.CHAT_URL))


def _reply(content=None, tool_calls=None):
    m = {"role": "assistant"}
    if content is not None:
        m["content"] = content
    if tool_calls:
        m["tool_calls"] = tool_calls
    return m


def _tool_call(call_id, args):
    return {"id": call_id, "type": "function", "function": {"name": "search_flights", "arguments": json.dumps(args)}}


def run(coro):
    return asyncio.run(coro)


def test_no_key_is_an_actionable_error():
    with pytest.raises(chatmod.ChatError, match="OPENROUTER_API_KEY"):
        run(chatmod.chat("flights to Rome"))


def test_a_clarifying_question_needs_no_tool_call(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    seen = {}
    def post(url, timeout, headers, json):
        seen["json"] = json
        return _resp(message=_reply(content="Which dates did you have in mind?"))
    monkeypatch.setattr(httpx, "post", post)
    r = run(chatmod.chat("I want to go to Rome"))
    assert r["reply"] == "Which dates did you have in mind?"
    assert r["session_id"]
    assert seen["json"]["messages"][0]["role"] == "system" and "flight-search assistant" in seen["json"]["messages"][0]["content"]
    assert seen["json"]["tools"][0]["function"]["name"] == "search_flights"


def test_a_tool_call_runs_a_real_search_and_the_model_writes_the_final_reply(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    calls = []
    def post(url, timeout, headers, json):
        calls.append(json)
        if len(calls) == 1:
            args = {"destinations": "ROM", "from_date": "2026-10-01", "to_date": "2026-10-20", "nights": "5"}
            return _resp(message=_reply(tool_calls=[_tool_call("call_1", args)]))
        # second round: the model has the tool's report in its messages and writes the summary
        assert calls[1]["messages"][-1]["role"] == "tool" and calls[1]["messages"][-1]["tool_call_id"] == "call_1"
        assert "DEMO DATA" in calls[1]["messages"][-1]["content"] or "```" not in calls[1]["messages"][-1]["content"]
        return _resp(message=_reply(content="Best pick: Rome, 5 nights. [mock data]"))
    monkeypatch.setattr(httpx, "post", post)
    r = run(chatmod.chat("cheapest 5 nights in Rome, Oct 1 to 20"))
    assert r["reply"] == "Best pick: Rome, 5 nights. [mock data]"
    assert len(calls) == 2


def test_a_bad_tool_call_is_told_to_the_model_not_raised(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    calls = []
    def post(url, timeout, headers, json):
        calls.append(json)
        if len(calls) == 1:
            return _resp(message=_reply(tool_calls=[_tool_call("call_1", {"destinations": "ROM"})]))   # missing required fields
        assert "Error" in calls[1]["messages"][-1]["content"]
        return _resp(message=_reply(content="I need the dates too."))
    monkeypatch.setattr(httpx, "post", post)
    r = run(chatmod.chat("go to rome"))
    assert r["reply"] == "I need the dates too."


def test_a_runaway_tool_loop_stops_instead_of_spinning_forever(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    monkeypatch.setattr(chatmod, "MAX_TOOL_ROUNDS", 2)
    n = []
    def post(url, timeout, headers, json):
        n.append(1)
        args = {"destinations": "ROM", "from_date": "2026-10-01", "to_date": "2026-10-20", "nights": "5"}
        return _resp(message=_reply(tool_calls=[_tool_call(f"call_{len(n)}", args)]))
    monkeypatch.setattr(httpx, "post", post)
    r = run(chatmod.chat("rome"))
    assert "couldn't put together" in r["reply"]
    assert len(n) == 2


def test_multi_turn_conversation_carries_history(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    seen = []
    def post(url, timeout, headers, json):
        seen.append(list(json["messages"]))
        return _resp(message=_reply(content=f"turn {len(seen)}"))
    monkeypatch.setattr(httpx, "post", post)
    r1 = run(chatmod.chat("hello"))
    r2 = run(chatmod.chat("still there?", r1["session_id"]))
    assert r1["session_id"] == r2["session_id"]
    # second call's message list includes the first turn's user + assistant messages before the new one
    roles = [m["role"] for m in seen[1]]
    assert roles == ["system", "user", "assistant", "user"]


def test_history_is_trimmed_by_whole_turns(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    monkeypatch.setattr(chatmod, "MAX_HISTORY", 3)
    def post(url, timeout, headers, json):
        return _resp(message=_reply(content="ok"))
    monkeypatch.setattr(httpx, "post", post)
    sid = None
    for i in range(5):
        sid = run(chatmod.chat(f"message {i}", sid))["session_id"]
    assert len(chatmod._sessions[sid]) <= 3
    assert chatmod._sessions[sid][0]["role"] == "user"   # trimmed on a user-message boundary, never mid-turn


def test_empty_and_oversized_messages_are_rejected(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    with pytest.raises(chatmod.ChatError):
        run(chatmod.chat("   "))
    with pytest.raises(chatmod.ChatError):
        run(chatmod.chat("x" * (chatmod.MAX_MESSAGE_CHARS + 1)))


def test_model_is_configurable(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    monkeypatch.setenv("FLIGHTAGENT_CHAT_MODEL", "some/other-model")
    seen = {}
    def post(url, timeout, headers, json):
        seen["model"] = json["model"]
        return _resp(message=_reply(content="ok"))
    monkeypatch.setattr(httpx, "post", post)
    run(chatmod.chat("hi"))
    assert seen["model"] == "some/other-model"


def test_http_failure_is_a_chat_error(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    def post(url, timeout, headers, json):
        return httpx.Response(500, text="server error", request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(chatmod.ChatError, match="500"):
        run(chatmod.chat("hi"))


# ---- the /api/chat endpoint ----

def test_endpoint_wraps_chat_error_as_400(monkeypatch):
    c = TestClient(app)
    r = c.post("/api/chat", json={"message": "hi"})
    assert r.status_code == 400 and "OPENROUTER_API_KEY" in r.json()["detail"]


def test_endpoint_returns_reply_and_session_id(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    def post(url, timeout, headers, json):
        return _resp(message=_reply(content="hello there"))
    monkeypatch.setattr(httpx, "post", post)
    c = TestClient(app)
    r = c.post("/api/chat", json={"message": "hi"})
    assert r.status_code == 200 and r.json()["reply"] == "hello there" and r.json()["session_id"]


def test_system_prompt_forcefully_instructs_combining_multiple_destinations():
    """Regression test for the bug where the model searched only one of several named destinations: the prompt must
    be explicit, with a worked example, not just a passing mention (the wording that shipped first wasn't enough)."""
    p = chatmod.system_prompt()
    assert "ROM,PAR,LON" in p and "Worked example" in p
    assert "NOT destinations=\"ROM\" alone" in p
    assert "NEVER call the tool once per city" in p


# ------------------------------------------------------------------ POST /api/chat/complete (the web app's chat)
def _complete(body, header=True):
    return TestClient(app).post("/api/chat/complete", json=body, headers={"X-Skyhop": "1"} if header else {})


def test_complete_relays_one_turn_with_the_page_s_tools(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    seen = {}
    def post(url, timeout, headers, json):
        seen.update(json=json, auth=headers["Authorization"])
        return _resp(message=_reply(tool_calls=[_tool_call("c1", {"destinations": ["ROM"]})]))
    monkeypatch.setattr(httpx, "post", post)
    tools = [{"type": "function", "function": {"name": "search_flights", "parameters": {"type": "object"}}}]
    r = _complete({"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "Rome"}], "tools": tools})
    assert r.status_code == 200 and r.json()["message"]["tool_calls"][0]["id"] == "c1"
    assert seen["json"]["tools"] == tools and seen["auth"] == "Bearer k" and "response_format" not in seen["json"]


def test_complete_can_ask_for_json_without_tools(monkeypatch):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    seen = {}
    monkeypatch.setattr(httpx, "post", lambda url, timeout, headers, json: seen.update(json=json) or _resp(message=_reply(content="{}")))
    assert _complete({"messages": [{"role": "user", "content": "sum up"}], "json_mode": True}).json()["message"]["content"] == "{}"
    assert seen["json"]["response_format"] == {"type": "json_object"} and "tools" not in seen["json"]


@pytest.mark.parametrize("body", [
    {"messages": []},
    {"messages": [{"role": "boss", "content": "x"}]},
    {"messages": [{"role": "user", "content": "x"}] * 81},
    {"messages": [{"role": "user", "content": "x" * 80_001}]},
    {"messages": [{"role": "user", "content": "x"}], "tools": [{}] * 5},
], ids=["empty", "bad role", "too many", "too long", "too many tools"])
def test_complete_refuses_requests_outside_the_limits(monkeypatch, body):
    monkeypatch.setenv("OPENROUTER_KEY", "k")
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("must not call the model"))
    assert _complete(body).status_code == 422


def test_complete_needs_the_page_header_and_a_key():
    assert _complete({"messages": [{"role": "user", "content": "x"}]}, header=False).status_code == 403
    r = _complete({"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 502 and "OPENROUTER_API_KEY" in r.json()["detail"]
