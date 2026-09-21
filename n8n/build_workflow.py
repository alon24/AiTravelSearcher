"""Generates n8n/flight-agent-chat.json (import via n8n UI: Workflows > Import from file)."""
import json
from pathlib import Path

SYSTEM = """=You are a flight-search assistant. Today is {{ $now.format('yyyy-MM-dd') }}.

Turn the user's request into one call of the `search_flights` tool.
- Origin defaults to TLV. Use IATA codes; city codes work (LON, PAR, ROM, NYC).
- You MUST know: destination(s), the date window (earliest departure and latest return) and the trip length in nights (one number or a range like 4-7). If any is missing or ambiguous, ask ONE short question first. Never invent dates.
- Map wishes to tool arguments: "direct only" -> direct_only=true; "max N stops" -> max_stops; "fly back from Brussels" (open-jaw) -> return_airports=BRU; "same airline both ways" -> same_airline=true; "allow separate tickets via Istanbul/Athens" -> self_transfer_hubs=IST,ATH; "also fly between the cities" -> connect_destinations=true.
- Searches cost API credits. Prefer narrow windows; if the tool returns an error about too many calls, ask the user to narrow the dates, nights or destinations.

Reply with the tool's report in a code block (keep alignment), then 2-3 lines: the best pick and why, and any SELF-TRANSFER or long-layover warning in plain words. If the report starts with "DEMO DATA", say the prices are fake test data."""

BODY = """={
  "origin": "{{ $fromAI('origin', 'Departure airport IATA code. Default TLV', 'string') }}",
  "destinations": "{{ $fromAI('destinations', 'Comma-separated IATA airport or city codes, e.g. ROM,PAR,LON', 'string') }}",
  "from_date": "{{ $fromAI('from_date', 'Earliest departure date, YYYY-MM-DD', 'string') }}",
  "to_date": "{{ $fromAI('to_date', 'Latest return date, YYYY-MM-DD', 'string') }}",
  "nights": "{{ $fromAI('nights', 'Trip length in nights: a number like 5 or a range like 4-7', 'string') }}",
  "return_airports": "{{ $fromAI('return_airports', 'Extra airports to fly home from (open-jaw), comma-separated. Empty string if none', 'string') }}",
  "direct_only": "{{ $fromAI('direct_only', 'true for nonstop flights only, else empty string', 'string') }}",
  "max_stops": "{{ $fromAI('max_stops', 'Max stops per direction as a number. Empty string for default (1)', 'string') }}",
  "max_travel_hours": "{{ $fromAI('max_travel_hours', 'Max total travel hours per direction. Empty string if no limit', 'string') }}",
  "same_airline": "{{ $fromAI('same_airline', 'true to force the same airline out and back, else empty string', 'string') }}",
  "self_transfer_hubs": "{{ $fromAI('self_transfer_hubs', 'Hub airports allowed for separate-ticket connections, comma-separated. Empty string if not allowed', 'string') }}",
  "connect_destinations": "{{ $fromAI('connect_destinations', 'true to also consider flying between the destinations, else empty string', 'string') }}",
  "currency": "{{ $fromAI('currency', 'Currency code such as USD or EUR. Empty string for USD', 'string') }}",
  "top": "{{ $fromAI('top', 'How many top recommendations to return, default 3', 'string') }}"
}"""

wf = {
    "id": "flightAgentChat02",
    "name": "Flight Agent (chat)",
    "nodes": [
        {"parameters": {"options": {"title": "Flight Agent",
                                    "subtitle": "Tell me where and when you want to fly."}},
         "type": "@n8n/n8n-nodes-langchain.chatTrigger", "typeVersion": 1.5,
         "position": [0, 0], "id": "a1f0c1a0-0001-4000-8000-000000000001", "name": "Chat",
         "webhookId": "a1f0c1a0-0001-4000-8000-0000000000aa"},
        {"parameters": {"options": {"systemMessage": SYSTEM}},
         "type": "@n8n/n8n-nodes-langchain.agent", "typeVersion": 3.1,
         "position": [300, 0], "id": "a1f0c1a0-0002-4000-8000-000000000002", "name": "Flight Agent"},
        {"parameters": {"model": "openai/gpt-4o-mini", "options": {"temperature": 0}},
         "type": "@n8n/n8n-nodes-langchain.lmChatOpenRouter", "typeVersion": 1,
         "position": [180, 260], "id": "a1f0c1a0-0003-4000-8000-000000000003", "name": "OpenRouter Model"},
        {"parameters": {"contextWindowLength": 12},
         "type": "@n8n/n8n-nodes-langchain.memoryBufferWindow", "typeVersion": 1.3,
         "position": [340, 260], "id": "a1f0c1a0-0004-4000-8000-000000000004", "name": "Chat Memory"},
        {"parameters": {
            "descriptionType": "manual",
            "toolDescription": "Search flights over a flexible date window with the flight API. Returns a text report: cheapest option per departure day plus top recommendations with segments, links and warnings, or an error message.",
            "method": "POST", "url": "http://flightagent:8765/search/simple",
            "sendBody": True, "contentType": "json", "specifyBody": "json", "jsonBody": BODY,
            "options": {"timeout": 180000}},
         "type": "n8n-nodes-base.httpRequestTool", "typeVersion": 4.2,
         "position": [520, 260], "id": "a1f0c1a0-0005-4000-8000-000000000005", "name": "search_flights"},
    ],
    "connections": {
        "Chat": {"main": [[{"node": "Flight Agent", "type": "main", "index": 0}]]},
        "OpenRouter Model": {"ai_languageModel": [[{"node": "Flight Agent", "type": "ai_languageModel", "index": 0}]]},
        "Chat Memory": {"ai_memory": [[{"node": "Flight Agent", "type": "ai_memory", "index": 0}]]},
        "search_flights": {"ai_tool": [[{"node": "Flight Agent", "type": "ai_tool", "index": 0}]]},
    },
    "settings": {"executionOrder": "v1"},
}
out = Path(__file__).with_name("flight-agent-chat.json")
out.write_text(json.dumps(wf, indent=2, ensure_ascii=False))
print("wrote", out)
