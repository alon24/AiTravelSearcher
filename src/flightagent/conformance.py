"""Provider conformance: run a candidate provider against a reference on the same routes and days and measure how
much they agree (docs/DESIGN.md section 8, item 7). The live runner is tests/provider_contract.py."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from .models import Offer
from .verify import flight_key, tolerance

MIN_OVERLAP = 0.95          # share of the reference's priced flights the candidate must also list
MIN_PRICE_AGREEMENT = 0.95  # share of shared flights whose prices agree within tolerance()


class SampleReport(BaseModel):
    origin: str
    dest: str
    day: date
    reference: int = 0                  # priced flights the reference lists
    candidate: int = 0
    shared: int = 0
    price_agree: int = 0
    dropped: list[str] = Field(default_factory=list)     # reference flights the candidate does not list
    deltas: list[float] = Field(default_factory=list)    # candidate - reference, per shared flight
    error: str = ""


class ContractReport(BaseModel):
    candidate: str
    reference: str
    samples: list[SampleReport]
    overlap: float          # shared / reference flights, over every sample that ran
    price_agreement: float  # agreeing / shared
    passed: bool


def _priced(offers: list[Offer]) -> dict:
    out: dict = {}
    for o in offers:
        if o.priced:
            k = flight_key(o.segments)
            out[k] = min(out.get(k, o.price), o.price)
    return out


def compare(origin: str, dest: str, day: date, reference: list[Offer], candidate: list[Offer]) -> SampleReport:
    ref, cand = _priced(reference), _priced(candidate)
    shared = [k for k in ref if k in cand]
    deltas = [round(cand[k] - ref[k], 2) for k in shared]
    return SampleReport(
        origin=origin, dest=dest, day=day, reference=len(ref), candidate=len(cand), shared=len(shared),
        price_agree=sum(abs(d) <= tolerance(ref[k]) for k, d in zip(shared, deltas)),
        dropped=["+".join(f"{c}{n}" for c, n, _ in k) + f" {k[0][2]}" for k in ref if k not in cand], deltas=deltas)


def summarize(candidate: str, reference: str, samples: list[SampleReport]) -> ContractReport:
    ran = [s for s in samples if not s.error]
    ref, shared = sum(s.reference for s in ran), sum(s.shared for s in ran)
    overlap = shared / ref if ref else 0.0
    agreement = sum(s.price_agree for s in ran) / shared if shared else 0.0
    return ContractReport(candidate=candidate, reference=reference, samples=samples, overlap=round(overlap, 3),
                          price_agreement=round(agreement, 3),
                          passed=bool(ran) and overlap >= MIN_OVERLAP and agreement >= MIN_PRICE_AGREEMENT)


async def run_contract(candidate, reference, routes: list[tuple[str, str, date]], *, currency: str = "USD",
                       adults: int = 1, max_stops: int = 1) -> ContractReport:
    """Query both providers for every (origin, dest, day) and compare. A sample where either side raises is reported
    with its error and left out of the rates (an outage is not disagreement)."""
    samples = []
    for o, d, day in routes:
        try:
            ref = await reference.one_way(o, d, day, currency=currency, adults=adults, max_stops=max_stops)
            cand = await candidate.one_way(o, d, day, currency=currency, adults=adults, max_stops=max_stops)
        except Exception as e:
            samples.append(SampleReport(origin=o, dest=d, day=day, error=str(e) or type(e).__name__))
            continue
        samples.append(compare(o, d, day, ref, cand))
    return summarize(candidate.name, reference.name, samples)
