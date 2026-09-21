from __future__ import annotations

from datetime import date
from urllib.parse import quote

# Booking directly with the airline is usually preferable (changes, refunds, baggage).
AIRLINE_SITES = {
    "LY": "https://www.elal.com",
    "W6": "https://wizzair.com",
    "FR": "https://www.ryanair.com",
    "U2": "https://www.easyjet.com",
    "IZ": "https://www.arkia.com",
    "6H": "https://www.israir.co.il",
    "TK": "https://www.turkishairlines.com",
    "A3": "https://en.aegeanair.com",
    "OS": "https://www.austrian.com",
    "LH": "https://www.lufthansa.com",
    "AF": "https://www.airfrance.com",
    "BA": "https://www.britishairways.com",
    "LO": "https://www.lot.com",
    "PC": "https://www.flypgs.com",
    "RO": "https://www.tarom.ro",
    "LX": "https://www.swiss.com",
    "SN": "https://www.brusselsairlines.com",
    "KL": "https://www.klm.com",
    "AZ": "https://www.ita-airways.com",
    "VY": "https://www.vueling.com",
}


def google_flights_link(origin: str, dest: str, day: date, return_day: date | None = None) -> str:
    q = f"Flights from {origin} to {dest} on {day.isoformat()}"
    q += f" through {return_day.isoformat()}" if return_day else " one way"
    return "https://www.google.com/travel/flights?q=" + quote(q)


# Common carriers, for filter suggestions in the UI (results always show the names the provider returned).
KNOWN_AIRLINES = {
    "LY": "El Al", "W4": "Wizz Air", "W6": "Wizz Air", "FR": "Ryanair", "RK": "Ryanair UK", "U2": "easyJet", "LS": "Jet2",
    "6H": "Israir", "IZ": "Arkia", "BZ": "Bluebird Airways", "TK": "Turkish Airlines", "PC": "Pegasus", "A3": "Aegean",
    "OA": "Olympic Air", "OS": "Austrian", "LH": "Lufthansa", "EW": "Eurowings", "AF": "Air France", "KL": "KLM",
    "BA": "British Airways", "VY": "Vueling", "IB": "Iberia", "AZ": "ITA Airways", "LX": "SWISS", "SN": "Brussels Airlines",
    "SK": "SAS", "DY": "Norwegian", "AY": "Finnair", "LO": "LOT", "RO": "TAROM", "OK": "Czech Airlines", "EK": "Emirates",
    "QR": "Qatar Airways", "EY": "Etihad", "MS": "EgyptAir", "RJ": "Royal Jordanian", "CY": "Cyprus Airways", "U8": "Tus Air",
    "GQ": "SKY express", "HV": "Transavia", "V7": "Volotea", "AA": "American", "DL": "Delta", "UA": "United", "B6": "JetBlue",
    "WN": "Southwest", "F9": "Frontier", "NK": "Spirit", "AC": "Air Canada", "SQ": "Singapore Airlines", "TG": "Thai Airways",
    "AI": "Air India", "ET": "Ethiopian", "KE": "Korean Air", "NH": "ANA", "JL": "Japan Airlines",
}
