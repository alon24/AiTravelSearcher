"""The airport list (web/airports.json, built by tools/build_airports.py from OpenFlights and OurAirports): real
airports, and which of them have scheduled flights, so a country search skips air bases."""
import json
from pathlib import Path

ROWS = {r[0]: r for r in json.loads((Path(__file__).resolve().parent.parent / "src/flightagent/web/airports.json").read_text(encoding="utf-8"))}


def test_portugals_airports_are_all_there_with_their_service():
    for code in ("LIS", "OPO", "FAO", "FNC", "PDL"):
        assert ROWS[code][3] == "Portugal" and ROWS[code][6] == 2, code       # large, scheduled flights
    assert ROWS["PXO"][6] == 1 and ROWS["AVR"][6] == 0                      # Porto Santo is served; Alverca is an air base
    assert ROWS["BER"][3] == "Germany" and ROWS["BER"][6] == 2              # newer airports (OurAirports) are there too
