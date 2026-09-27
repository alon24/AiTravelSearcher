"""Natural-language flight search, entirely in this service -- what n8n's chat workflow used to do
(n8n/flight-agent-chat.json, removed), now built in rather than routed through a separate app.

A chat model (via OpenRouter, same account and key as Jev -- see decide.py) reads your message, asks ONE
short question if a required detail (destinations, dates, trip length) is missing, otherwise calls the
`search_flights` tool with SimpleSearch's fields; the tool runs a real search (simple.run_simple_search,
the same code POST /search/simple calls) and the model writes 2-3 lines about the result. Multi-turn: pass
back the `session_id` a call returns to continue the same conversation.

Config: OPENROUTER_API_KEY (or OPENROUTER_KEY, already used for Jev). Model: FLIGHTAGENT_CHAT_MODEL
(default openai/gpt-4o-mini, matching what the n8n workflow used). Sessions live in memory only (lost on
restart, like n8n's default buffer memory did) and are capped (MAX_SESSIONS, MAX_HISTORY) so a long-running
server can't grow this without bound.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import date

import httpx

from .decide import openrouter_key
from .simple import SimpleSearch, run_simple_search

CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-4o-mini"
MAX_MESSAGE_CHARS = 2000       # one chat message from a person; generous, but not "paste a novel"
MAX_HISTORY = 24               # messages kept per session (excluding the system prompt), oldest trimmed first
MAX_SESSIONS = 500             # sessions kept at all; oldest evicted first once over (an idle chat costs nothing else)
MAX_TOOL_ROUNDS = 3            # a runaway loop of tool calls stops here instead of spinning forever


class ChatError(RuntimeError):
    """Something stopped the chat from getting an answer at all (no key, the model unreachable, bad input)."""


def system_prompt() -> str:
    return f"""You are a flight-search assistant. Today is {date.today().isoformat()}.

Turn the user's request into one call of the `search_flights` tool.
- Origin defaults to TLV. Use IATA codes; city codes work (LON, PAR, ROM, NYC).
- Several cities joined by "or", commas or "cheapest of" (e.g. "Rome, Paris or London") means: search ALL of them together in ONE call with destinations=ROM,PAR,LON. The search compares them for the user. NEVER ask the user to pick one of the cities.
- You MUST know: destination(s), the date window (earliest departure and latest return) and the trip length in nights (one number or a range like 4-7). If any is missing or ambiguous, ask ONE short question first. Never invent dates.
- Travellers: adults defaults to 1. If the user mentions children, you MUST know every child's age (ask ONE short question if missing) and pass them as children_ages, comma-separated, e.g. "5,8". Age under 2 = infant on a lap (needs an adult); 2-11 = child; 12+ counts as an adult. Prices in the report are totals for everyone.
- Airlines: "no Ryanair" -> exclude_airlines=FR,RK; "only El Al" -> only_airlines=LY. Use IATA codes (Ryanair FR/RK, Wizz Air W4/W6, easyJet U2, El Al LY, Israir 6H, Bluebird BZ, Turkish TK, Aegean A3). To answer "does X fly to/from Y", run the search and read the report's AIRLINES SEEN section: it lists every airline found on those routes with each direction and whether it is nonstop. If an airline is not listed, say it was not offered for those routes and dates.
- Map wishes to tool arguments: "direct only" -> direct_only=true; "max N stops" -> max_stops; "fly back from Brussels" (open-jaw) -> return_airports=BRU; "same airline both ways" -> same_airline=true; "allow separate tickets via Istanbul/Athens" -> self_transfer_hubs=IST,ATH; "also fly between the cities" -> connect_destinations=true.
- Searches cost lookups. Prefer narrow windows; if the tool returns an error about too many calls, ask the user to narrow the dates, nights or destinations.
- Skyhop never books a flight or takes payment. If asked to book, say so, and point at the "Check on <Airline> site" / "Select ... on site" buttons in the web app, or the airline's own website.

Reply with the tool's report in a code block (keep alignment), then 2-3 lines: the best pick and why, and any SELF-TRANSFER or long-layover warning in plain words. If the report starts with "DEMO DATA", say the prices are fake test data. Finish with the report's last bracketed line (data sources and timing) copied exactly."""


TOOL_SPEC = [{
    "type": "function",
    "function": {
        "name": "search_flights",
        "description": "Search flights over a flexible date window. Returns a text report: cheapest option per "
                        "departure day plus top recommendations with segments, links and warnings, or an error message.",
        "parameters": {
            "type": "object",
            "properties": {
                "origin": {"type": "string", "description": "Departure airport IATA code. Default TLV."},
                "destinations": {"type": "string", "description": "Comma-separated IATA airport or city codes, e.g. ROM,PAR,LON."},
                "from_date": {"type": "string", "description": "Earliest departure date, YYYY-MM-DD."},
                "to_date": {"type": "string", "description": "Latest return date, YYYY-MM-DD."},
                "nights": {"type": "string", "description": "Trip length in nights: a number like 5 or a range like 4-7."},
                "return_airports": {"type": "string", "description": "Extra airports to fly home from (open-jaw), comma-separated. Empty string if none."},
                "direct_only": {"type": "string", "description": "\"true\" for nonstop flights only, else empty string."},
                "max_stops": {"type": "string", "description": "Max stops per direction as a number. Empty string for default (1)."},
                "max_travel_hours": {"type": "string", "description": "Max total travel hours per direction. Empty string if no limit."},
                "same_airline": {"type": "string", "description": "\"true\" to force the same airline out and back, else empty string."},
                "self_transfer_hubs": {"type": "string", "description": "Hub airports allowed for separate-ticket connections, comma-separated. Empty string if not allowed."},
                "connect_destinations": {"type": "string", "description": "\"true\" to also consider flying between the destinations, else empty string."},
                "adults": {"type": "string", "description": "Number of adults (12+). Empty string for 1."},
                "children_ages": {"type": "string", "description": "Ages of children, comma-separated, e.g. 5,8. Empty string if none."},
                "exclude_airlines": {"type": "string", "description": "IATA codes of airlines to exclude, comma-separated, e.g. FR,RK. Empty string if none."},
                "only_airlines": {"type": "string", "description": "IATA codes to allow exclusively, comma-separated. Empty string for all airlines."},
                "currency": {"type": "string", "description": "Currency code such as USD or EUR. Empty string for USD."},
                "top": {"type": "string", "description": "How many top recommendations to return, default 3."},
            },
            "required": ["destinations", "from_date", "to_date", "nights"],
        },
    },
}]

_lock = threading.Lock()
_sessions: dict[str, list[dict]] = {}   # session_id -> messages (role/content[/tool_calls/tool_call_id]), no system prompt
_order: list[str] = []                  # session ids in the order first seen, for MAX_SESSIONS eviction


def _get_history(session_id: str | None) -> tuple[str, list[dict]]:
    import uuid
    with _lock:
        if session_id and session_id in _sessions:
            return session_id, list(_sessions[session_id])
        session_id = session_id or uuid.uuid4().hex
        _sessions.setdefault(session_id, [])
        _order.append(session_id)
        while len(_order) > MAX_SESSIONS:
            _sessions.pop(_order.pop(0), None)
        return session_id, []


def _save_history(session_id: str, messages: list[dict]) -> None:
    with _lock:
        # Trim from the front, but only ever drop a whole "turn" (up to and including the next user message) so a
        # tool call is never separated from its own result.
        while len(messages) > MAX_HISTORY:
            cut = next((i for i, m in enumerate(messages[1:], 1) if m.get("role") == "user"), len(messages))
            messages = messages[cut:]
        _sessions[session_id] = messages


def _call_model(messages: list[dict], key: str, model: str) -> dict:
    try:
        r = httpx.post(CHAT_URL, timeout=60.0,
                       headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Title": "Skyhop flightagent chat"},
                       json={"model": model, "messages": messages, "tools": TOOL_SPEC, "temperature": 0})
    except httpx.HTTPError as e:
        raise ChatError(f"couldn't reach the chat model: {e}") from e
    if r.status_code != 200:
        raise ChatError(f"chat model HTTP {r.status_code}: {r.text[:200]}")
    try:
        return r.json()["choices"][0]["message"]
    except (KeyError, IndexError, ValueError) as e:
        raise ChatError(f"unexpected response from the chat model: {e}") from e


async def chat(message: str, session_id: str | None = None) -> dict:
    """One turn of the chat. Returns {"reply": str, "session_id": str}. Raises ChatError for anything that stops
    the conversation outright (never for a search that simply found nothing or hit a budget limit -- the model
    sees that as a normal tool result and reacts to it, same as n8n's agent did)."""
    key = openrouter_key()
    if not key:
        raise ChatError("no OpenRouter key: set OPENROUTER_API_KEY (or OPENROUTER_KEY) in .env and restart")
    message = (message or "").strip()
    if not message:
        raise ChatError("empty message")
    if len(message) > MAX_MESSAGE_CHARS:
        raise ChatError(f"message is longer than {MAX_MESSAGE_CHARS} characters")
    model = os.environ.get("FLIGHTAGENT_CHAT_MODEL", DEFAULT_MODEL)

    session_id, history = _get_history(session_id)
    messages = [{"role": "system", "content": system_prompt()}, *history, {"role": "user", "content": message}]

    for _ in range(MAX_TOOL_ROUNDS):
        reply = _call_model(messages, key, model)
        messages.append(reply)
        calls = reply.get("tool_calls") or []
        if not calls:
            _save_history(session_id, messages[1:])
            return {"reply": reply.get("content") or "", "session_id": session_id}
        for call in calls:
            try:
                args = json.loads(call["function"]["arguments"])
                result = await run_simple_search(SimpleSearch(**args))
                content = result.get("report") or f"Error: {result.get('error', 'unknown error')}"
            except Exception as e:      # a malformed tool call, or a genuinely bad search: tell the MODEL, not the caller
                content = f"Error: {e}"
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})

    # The model kept calling the tool without ever answering: say so plainly rather than looping forever.
    _save_history(session_id, messages[1:])
    return {"reply": "Sorry, I couldn't put together an answer from that search. Try narrowing the dates or destinations.",
            "session_id": session_id}
