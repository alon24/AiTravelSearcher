from __future__ import annotations

from .engine import airline_site
from .models import LegView, SearchResult, Trip


def _hm(minutes: int) -> str:
    return f"{minutes // 60}h{minutes % 60:02d}"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    line = lambda cells: " | ".join(c.ljust(w) for c, w in zip(cells, widths))
    return "\n".join([line(headers), "-+-".join("-" * w for w in widths), *(line(r) for r in rows)])


def _row(t: Trip) -> list[str]:
    return [
        t.depart_date.strftime("%a %d/%m/%Y"), t.return_date.strftime("%a %d/%m/%Y"),
        str(t.nights), t.destination, ",".join(t.airlines), t.flight_type + (" *ST" if t.self_transfer else ""),
        _hm(t.total_travel_min), f"{t.price:,.0f} {t.currency}",
    ]


def _leg_lines(leg: LegView, title: str) -> list[str]:
    st = "  [SELF-TRANSFER]" if leg.self_transfer else ""
    lines = [f"  {title}: {leg.origin} → {leg.destination}  {leg.price:,.0f}  "
             f"({_hm(leg.duration_min)}, {'direct' if leg.stops == 0 else f'{leg.stops} stop(s)'}){st}"]
    for i, s in enumerate(leg.segments):
        lines.append(f"    {s.label:<8} {s.origin} {s.departs:%a %d/%m %H:%M} → "
                     f"{s.destination} {s.arrives:%a %d/%m %H:%M}  {s.airline}")
        if i < len(leg.layovers_min):
            lines.append(f"             layover at {s.destination}: {_hm(leg.layovers_min[i])}")
    return lines


def render(result: SearchResult) -> str:
    out: list[str] = [f"Travellers: {result.request.pax_label} (prices are totals)"]
    headers = ["Depart", "Return", "Nts", "Dest", "Airlines", "Type", "Travel", "Price"]
    out.append("CHEAPEST OPTION PER DEPARTURE DAY")
    out.append(_table(headers, [_row(d.cheapest) for d in result.daily]) if result.daily else "(none)")
    out.append("\nTOP RECOMMENDATIONS (best value = price + value of time; lower effective cost is better)")
    for n, t in enumerate(result.top, 1):
        out.append(f"\n#{n}  {t.destination} [{t.kind}]  {t.depart_date} → {t.return_date} "
                   f"({t.nights} nights)  {t.price:,.0f} {t.currency}  "
                   f"effective cost {t.effective_cost:,.0f}")
        for i, leg in enumerate(t.legs):
            title = {2: ["Outbound", "Return"], 3: ["Outbound", "Between", "Return"]}[len(t.legs)][i]
            out += _leg_lines(leg, title)
            for link in leg.deep_links:
                out.append(f"    search: {link}")
            for code in leg.airlines:
                if site := airline_site(code):
                    out.append(f"    book direct ({code}): {site}")
        out += [f"  ⚠ {w}" for w in t.warnings]
    via = ", ".join(f"{name} x{n}" for name, n in sorted(result.sources.items())) or "no live lookups"
    out.append(f"\n[{result.api_calls} lookups via {via} | {result.cache_hits} cached | {result.elapsed_s}s]")
    out += [f"⚠ {w}" for w in result.warnings]
    return "\n".join(out)
