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
    "RO": "https://www.tarom.ro/en",   # the English site (www.tarom.ro alone is Romanian)
    "LX": "https://www.swiss.com",
    "SN": "https://www.brusselsairlines.com",
    "KL": "https://www.klm.com",
    "AZ": "https://www.ita-airways.com",
    "VY": "https://www.vueling.com",
    "H4": "https://www.hisky.com",
    # More airlines (their homepages resolved on 2026-09-27); anything not listed still gets a "Find <airline> on Google" button.
    "4Y": "https://www.discover-airlines.com",
    "9U": "https://www.airmoldova.md",
    "A9": "https://www.georgian-airways.com",
    "AA": "https://aa.com",
    "AC": "https://www.aircanada.com",
    "AI": "https://www.airindia.com",
    "AM": "https://www.aeromexico.com",
    "AY": "https://finnair.com",
    "BT": "https://www.airbaltic.com",
    "BZ": "https://www.bluebirdair.com",
    "CM": "https://www.copaair.com",
    "CX": "https://www.cathaypacific.com",
    "CY": "https://www.cyprusairways.com",
    "DL": "https://www.delta.com",
    "EK": "https://emirates.com",
    "ET": "https://www.ethiopianairlines.com",
    "EW": "https://www.eurowings.com",
    "EY": "https://etihad.com",
    "FB": "https://www.air.bg",
    "FZ": "https://www.flydubai.com",
    "G9": "https://airarabia.com",
    "GF": "https://gulfair.com",
    "GQ": "https://www.skyexpress.gr",
    "HU": "https://www.hainanairlines.com",
    "HV": "https://www.transavia.com",
    "HY": "https://www.uzairways.com",
    "IB": "https://www.iberia.com",
    "J2": "https://www.azal.az",
    "JU": "https://www.airserbia.com",
    "KC": "https://www.airastana.com",
    "MS": "https://www.egyptair.com",
    "OA": "https://www.aegeanair.com",
    "OK": "https://www.csa.cz",
    "OU": "https://www.croatiaairlines.com",
    "RJ": "https://www.rj.com",
    "RK": "https://www.ryanair.com",
    "SK": "https://www.flysas.com",
    "TG": "https://www.thaiairways.com",
    "TP": "https://www.flytap.com",
    "TS": "https://www.airtransat.com",
    "U8": "https://www.tusairways.com",
    "UA": "https://united.com",
    "UX": "https://aireuropa.com",
    "VS": "https://virginatlantic.com",
    "W4": "https://www.wizzair.com",
    "W9": "https://www.wizzair.com",
    "XQ": "https://www.sunexpress.com",
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
    "GQ": "SKY express", "H4": "HiSky", "Q4": "Euroairlines", "HV": "Transavia", "V7": "Volotea", "AA": "American", "DL": "Delta", "UA": "United", "B6": "JetBlue",
    "WN": "Southwest", "F9": "Frontier", "NK": "Spirit", "AC": "Air Canada", "SQ": "Singapore Airlines", "TG": "Thai Airways",
    "AI": "Air India", "ET": "Ethiopian", "KE": "Korean Air", "NH": "ANA", "JL": "Japan Airlines",
}


# General baggage policy notes for airlines whose base-fare rules are well known. Not from Google and not per fare:
# airlines change these, so the UI labels them "typical" and tells the user to confirm on the airline's site.
BAG_NOTES = {
    "FR": "Typically the base fare covers one small personal bag; a cabin bag and checked bags cost extra.",
    "RK": "Typically the base fare covers one small personal bag; a cabin bag and checked bags cost extra.",
    "W4": "Typically the base fare covers one small personal item; a trolley cabin bag and checked bags cost extra.",
    "W6": "Typically the base fare covers one small personal item; a trolley cabin bag and checked bags cost extra.",
    "U2": "Typically the base fare covers one small under-seat bag; a larger cabin bag and hold bags cost extra.",
    "F9": "Typically the base fare covers a personal item only; cabin and checked bags cost extra.",
    "NK": "Typically the base fare covers a personal item only; cabin and checked bags cost extra.",
    "LY": "Economy Light typically has no checked bag (a cabin bag and personal item only, and on Europe routes the cabin bag may be gate-checked); Classic and Flex fares typically include a checked bag.",
    "6H": "Typically a cabin bag (about 8 kg) and a personal item are included; a checked bag is usually a paid extra. It depends on the fare and route.",
    "RO": "Cabin bag and personal item are included on all fares (about 8 kg combined). Economy Light has no checked bag; other economy fares typically include one 23 kg bag.",
}

# Short chip text for the same airlines (the full note is the tooltip).
BAG_SHORT = {
    "FR": "bags usually extra", "RK": "bags usually extra", "W4": "bags usually extra", "W6": "bags usually extra",
    "U2": "bags usually extra", "F9": "bags usually extra", "NK": "bags usually extra",
    "LY": "checked bag depends on fare", "RO": "checked bag depends on fare", "6H": "checked bag usually extra",
}
