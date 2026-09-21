from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date

from dotenv import load_dotenv

from .api import build_engine
from .engine import BudgetExceeded
from .models import SearchRequest
from .report import render


def _csv(s: str) -> list[str]:
    return [x.strip() for x in s.split(",") if x.strip()]


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    p = argparse.ArgumentParser(prog="flightagent", description="Flexible flight search agent")
    p.add_argument("--origin", default="TLV")
    p.add_argument("--to", required=True, type=_csv, help="comma-separated destinations, e.g. ROM,PAR,LON")
    p.add_argument("--return-from", default=[], type=_csv, help="extra open-jaw return airports, e.g. BRU")
    p.add_argument("--no-open-jaw", action="store_true")
    p.add_argument("--connect", action="store_true", help="also suggest legs between the destinations")
    p.add_argument("--from-date", required=True, type=date.fromisoformat)
    p.add_argument("--to-date", required=True, type=date.fromisoformat)
    p.add_argument("--nights", required=True, help="N or MIN-MAX, e.g. 5 or 4-7")
    p.add_argument("--direct-only", action="store_true")
    p.add_argument("--max-stops", type=int, default=1)
    p.add_argument("--min-layover", type=float, default=1.5, help="hours")
    p.add_argument("--max-layover", type=float, default=72, help="hours")
    p.add_argument("--max-travel", type=float, help="max hours per direction")
    p.add_argument("--same-airline", action="store_true", help="forbid different airlines out/back")
    p.add_argument("--self-transfer", type=_csv, default=[], metavar="HUBS",
                   help="allow separate-ticket connections via these hubs, e.g. IST,ATH,VIE")
    p.add_argument("--buffer", type=float, default=4, help="self-transfer buffer, hours")
    p.add_argument("--adults", type=int, default=1)
    p.add_argument("--children", type=lambda s: [int(x) for x in _csv(s)], default=[], metavar="AGES", help="children's ages, e.g. 5,8")
    p.add_argument("--currency", default="USD")
    p.add_argument("--vot", type=float, default=10, help="value of an hour of travel, in currency")
    p.add_argument("--top", type=int, default=5)
    p.add_argument("--max-calls", type=int, default=400)
    p.add_argument("--json", action="store_true", help="print JSON instead of the text report")
    a = p.parse_args(argv)

    lo, _, hi = a.nights.partition("-")
    req = SearchRequest(
        origin=a.origin, destinations=a.to, return_airports=a.return_from,
        open_jaw=not a.no_open_jaw, connect_destinations=a.connect,
        window_start=a.from_date, window_end=a.to_date,
        min_nights=int(lo), max_nights=int(hi or lo),
        allow_connections=not a.direct_only, max_stops_per_leg=a.max_stops,
        min_layover_min=int(a.min_layover * 60), max_layover_min=int(a.max_layover * 60),
        max_travel_min_per_direction=int(a.max_travel * 60) if a.max_travel else None,
        allow_mixed_airlines=not a.same_airline,
        allow_self_transfer=bool(a.self_transfer), self_transfer_hubs=a.self_transfer,
        self_transfer_buffer_min=int(a.buffer * 60), currency=a.currency, adults=a.adults, children_ages=a.children,
        value_of_time_per_hour=a.vot, top_n=a.top, max_api_calls=a.max_calls,
    )
    try:
        result = asyncio.run(build_engine().search(req))
    except (BudgetExceeded, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(result.model_dump_json(indent=2) if a.json else render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
