"""A there-and-back trip links to Google Flights' round-trip search for the same dates and travellers, since one return
ticket can cost less than the two one-way tickets Skyhop adds up (web/app.js googleRoundTripUrl)."""
import base64
from urllib.parse import parse_qs, urlsplit

import pytest

pytest.importorskip("playwright.sync_api")


def _fields(b: bytes) -> list[tuple[int, object]]:
    """A protobuf message as (field, value) pairs: ints for varints, bytes for length-delimited values."""
    out, i = [], 0

    def varint():
        nonlocal i
        n = shift = 0
        while True:
            c = b[i]
            i += 1
            n |= (c & 0x7F) << shift
            shift += 7
            if c < 0x80:
                return n
    while i < len(b):
        key = varint()
        if key & 7 == 0:
            out.append((key >> 3, varint()))
        else:
            n = varint()
            out.append((key >> 3, b[i:i + n]))
            i += n
    return out


def test_round_trip_link_opens_googles_return_ticket_search(page):
    page.evaluate("""() => { const f = readForm(); f.to = ['ATH']; f.start = '2026-11-02'; f.end = '2026-11-04';
                             f.lenMode = 'range'; f.nmin = 3; f.nmax = 3; f.adults = 2; f.kids = [5]; f.currency = 'EUR';
                             writeForm(f); onFormChange(); }""")
    page.wait_for_function("!document.querySelector('#go').disabled")
    page.click("#go")
    link = page.get_by_role("link", name="Compare with a round-trip ticket ↗").first
    link.wait_for(timeout=60000)
    trip = page.locator("article.trip", has=link).first
    out, back = trip.locator(".leg").nth(0).inner_text(), trip.locator(".leg").nth(1).inner_text()

    url = urlsplit(link.get_attribute("href"))
    q = parse_qs(url.query)
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://www.google.com/travel/flights" and q["curr"] == ["EUR"]
    info = _fields(base64.b64decode(q["tfs"][0]))
    legs = [dict(_fields(v)) for f, v in info if f == 3]
    places = [(dict(_fields(leg[13])), dict(_fields(leg[14]))) for leg in legs]
    assert [(a[1], a[2].decode(), z[1], z[2].decode()) for a, z in places] == [(1, "TLV", 1, "ATH"), (1, "ATH", 1, "TLV")]
    out_day, back_day = legs[0][2].decode(), legs[1][2].decode()
    assert "2026-11-02" <= out_day <= "2026-11-04" and out_day < back_day
    assert "TLV" in out and "ATH" in back
    rest = dict((f, v) for f, v in info if f != 3)
    assert list(rest[8]) == [1, 1, 2] and rest[9] == 1 and rest[19] == 1   # 2 adults + a child, economy, round trip
