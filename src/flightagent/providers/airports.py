from __future__ import annotations

# Google Flights rejects IATA *city* codes (ROM, LON, ...) but accepts comma-separated airports.
CITY_AIRPORTS = {
    "ROM": "FCO,CIA", "LON": "LHR,LGW,STN,LTN,LCY", "PAR": "CDG,ORY,BVA", "NYC": "JFK,EWR,LGA",
    "MIL": "MXP,LIN,BGY", "BER": "BER", "STO": "ARN,BMA,NYO", "MOW": "SVO,DME,VKO",
    "TYO": "HND,NRT", "WAS": "IAD,DCA,BWI", "CHI": "ORD,MDW", "BUH": "OTP,BBU",
    "BJS": "PEK,PKX", "OSA": "KIX,ITM", "SAO": "GRU,CGH,VCP", "BUE": "EZE,AEP",
    "MAD": "MAD", "BRU": "BRU", "IST": "IST,SAW", "VCE": "VCE,TSF",
}


def expand(code: str) -> str:
    """City code -> comma-separated airport codes; anything else passes through."""
    return CITY_AIRPORTS.get(code.upper(), code.upper())
