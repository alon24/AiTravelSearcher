"""Provider conformance check (docs/DESIGN.md section 8): run a candidate provider against a reference provider on a
fixed set of routes and report flight overlap, price agreement and dropped flights. Uses the live providers, so it is
not collected by pytest. A new provider must pass (>= 95 % overlap and price agreement) before it is enabled.

    python tests/provider_contract.py --candidate serpapi --reference gflights [--days-ahead 30] [--json]
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date, timedelta

from flightagent.conformance import MIN_OVERLAP, MIN_PRICE_AGREEMENT, run_contract
from flightagent.providers import get_provider

# Short and long haul, low-cost and legacy carriers, from the routes Skyhop is used on most.
ROUTES = [("TLV", "FCO"), ("TLV", "ATH"), ("TLV", "LCA"), ("TLV", "BUD"), ("TLV", "LHR"), ("FCO", "TLV")]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--reference", default="gflights")
    ap.add_argument("--days-ahead", type=int, nargs="+", default=[14, 45])
    ap.add_argument("--currency", default="USD")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    routes = [(o, d, date.today() + timedelta(days=n)) for o, d in ROUTES for n in a.days_ahead]
    report = asyncio.run(run_contract(get_provider(a.candidate), get_provider(a.reference), routes, currency=a.currency))
    if a.json:
        print(report.model_dump_json(indent=2))
    else:
        for s in report.samples:
            if s.error:
                print(f"{s.origin}->{s.dest} {s.day}: ERROR {s.error}")
                continue
            worst = max(s.deltas, key=abs, default=0)
            print(f"{s.origin}->{s.dest} {s.day}: {s.shared}/{s.reference} shared, {s.price_agree} agree, "
                  f"largest delta {worst:+.2f}" + (f", dropped {', '.join(s.dropped[:5])}" if s.dropped else ""))
        print(f"\noverlap {report.overlap:.1%} (need {MIN_OVERLAP:.0%}), price agreement {report.price_agreement:.1%} "
              f"(need {MIN_PRICE_AGREEMENT:.0%}): {'PASS' if report.passed else 'FAIL'}")
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
