"""Builds src/flightagent/web/airports.json from OpenFlights data (ODbL) + our popularity list and aliases.

    python tools/build_airports.py            # downloads airports.dat if missing
Row format: [iata, city, airport name, country, rank, [aliases]]  rank: 0 normal, 1 popular, 2 city group.
"""
import csv, json, sys, urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat"
OUT = Path(__file__).resolve().parents[1] / "src/flightagent/web/airports.json"
DAT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/airports.dat")

EXTRA = [("BER", "Berlin", "Berlin Brandenburg Airport", "Germany")]  # missing from the OpenFlights snapshot
POPULAR = set("""TLV LHR LGW STN LTN LCY CDG ORY BVA FCO CIA MXP LIN BGY BCN MAD AMS FRA MUC BER VIE ZRH BRU CPH ARN OSL HEL
DUB LIS OPO ATH SKG IST SAW AYT ESB BUD PRG WAW KRK GDN OTP BBU SOF BEG ZAG LCA PFO RHO HER JTR CHQ CFU KGS MLA NAP VCE TSF BLQ PSA
FLR CTA PMO BRI CAG NCE LYS MRS TLS BOD NTE GVA BSL HAM DUS CGN STR NUE MAN EDI GLA BHX BRS LPL NCL BFS AGP PMI IBZ VLC SVQ BIO ALC
TFS LPA ACE FUE FAO MAH SPU DBV PUY TIV TGD SKP OHD TIA SJJ LJU BTS RIX VNO TLL KEF GOT SZG INN VRN TRN GOA KIV TBS EVN GYD
JFK EWR LGA LAX SFO MIA ORD BOS IAD DCA ATL DFW IAH LAS SEA DEN PHX MCO SAN YYZ YUL YVR MEX CUN BOG LIM SCL PTY GRU GIG EZE
DXB AUH DOH RUH JED BAH MCT KWI CAI SSH HRG AMM ETH ETM AQJ BEY CMN RAK TUN LOS ACC NBO ADD JNB CPT MRU
BKK HKT SIN KUL HKG NRT HND KIX ICN PEK PVG DEL BOM BLR MAA HYD CCU CMB MLE KTM DPS SGN HAN MNL CGK PNH SYD MEL AKL""".split())

# City groups the flight providers understand (see providers/airports.py)
GROUPS = {"ROM": ("Rome", "Italy"), "LON": ("London", "United Kingdom"), "PAR": ("Paris", "France"), "NYC": ("New York", "United States"),
          "MIL": ("Milan", "Italy"), "STO": ("Stockholm", "Sweden"), "MOW": ("Moscow", "Russia"), "TYO": ("Tokyo", "Japan"),
          "WAS": ("Washington", "United States"), "CHI": ("Chicago", "United States"), "BUH": ("Bucharest", "Romania"),
          "BJS": ("Beijing", "China"), "OSA": ("Osaka", "Japan"), "SAO": ("Sao Paulo", "Brazil"), "BUE": ("Buenos Aires", "Argentina")}

# Alternate spellings, local names and Hebrew names. Matching is diacritic- and case-insensitive.
ALIASES = {
    "TLV": ["tel aviv", "ben gurion", "נתבג", "תל אביב", "נתב״ג"], "ROM": ["roma", "רומא"], "FCO": ["fiumicino", "leonardo da vinci"],
    "LON": ["londres", "londra", "לונדון"], "LHR": ["heathrow", "היתרו"], "LGW": ["gatwick", "גטוויק"], "STN": ["stansted"], "LTN": ["luton"],
    "PAR": ["parigi", "paris", "פריז"], "CDG": ["charles de gaulle", "roissy"], "ORY": ["orly"], "BVA": ["beauvais"],
    "BUH": ["bucuresti", "bucarest", "bukarest", "בוקרשט"], "OTP": ["bucuresti", "bucarest", "bukarest", "henri coanda", "otopeni", "בוקרשט"],
    "BBU": ["baneasa", "aurel vlaicu"], "ATH": ["athina", "athinai", "אתונה"], "PRG": ["praha", "praga", "prag", "פראג"],
    "VIE": ["wien", "viena", "וינה"], "BUD": ["budapest", "budapesht", "בודפשט"], "WAW": ["warszawa", "varsovia", "varsovie", "ורשה"],
    "KRK": ["krakow", "cracovia", "קרקוב"], "BER": ["berlino", "ברלין"], "MUC": ["munchen", "monaco di baviera", "מינכן"],
    "FRA": ["frankfurt am main", "פרנקפורט"], "AMS": ["schiphol", "אמסטרדם"], "BRU": ["bruxelles", "brussel", "בריסל"],
    "BCN": ["barcelona", "ברצלונה"], "MAD": ["barajas", "מדריד"], "LIS": ["lisboa", "ליסבון"], "OPO": ["oporto", "פורטו"],
    "DUB": ["baile atha cliath", "דבלין"], "CPH": ["kobenhavn", "קופנהגן"], "ARN": ["stockholm arlanda", "שטוקהולם"], "OSL": ["אוסלו"],
    "HEL": ["helsingfors", "הלסינקי"], "ZRH": ["zurich", "צריך"], "GVA": ["geneve", "genf", "ג׳נבה", "ג'נבה"],
    "MXP": ["milano", "malpensa", "מילאנו"], "MIL": ["milano", "milan", "מילאנו"], "NAP": ["napoli", "naples", "נאפולי"],
    "VCE": ["venezia", "venice", "marco polo", "ונציה"], "FLR": ["firenze", "florence", "פירנצה"], "BLQ": ["bologna", "בולוניה"],
    "PSA": ["pisa", "פיזה"], "TRN": ["torino", "turin", "טורינו"], "CTA": ["catania", "קטניה"], "PMO": ["palermo", "פלרמו"],
    "IST": ["constantinople", "istanbul", "איסטנבול"], "SAW": ["sabiha gokcen", "איסטנבול"], "AYT": ["antalya", "אנטליה"],
    "LCA": ["larnaka", "cyprus", "לרנקה", "קפריסין"], "PFO": ["pafos", "paphos", "cyprus", "פאפוס", "קפריסין"], "RHO": ["rodos", "rhodes", "רודוס"],
    "HER": ["iraklion", "heraklion", "crete", "כרתים", "הרקליון"], "CHQ": ["chania", "hania", "crete", "כרתים"], "JTR": ["thira", "santorini", "סנטוריני"],
    "SKG": ["salonica", "thessaloniki", "סלוניקי"], "CFU": ["kerkyra", "corfu", "קורפו"], "DXB": ["dubai", "דובאי"], "AUH": ["abu dhabi", "אבו דאבי"],
    "CAI": ["cairo", "קהיר"], "SSH": ["sharm el sheikh", "sharm", "שארם"], "HRG": ["hurghada", "הורגדה"], "AMM": ["amman", "queen alia", "עמאן"],
    "NYC": ["new york", "ניו יורק"], "JFK": ["new york", "ניו יורק"], "EWR": ["newark", "new york", "ניו יורק"], "LGA": ["laguardia", "new york"],
    "LAX": ["los angeles", "לוס אנג׳לס", "לוס אנג'לס"], "MIA": ["miami", "מיאמי"], "SFO": ["san francisco", "סן פרנסיסקו"],
    "BKK": ["krung thep", "suvarnabhumi", "בנגקוק"], "HKT": ["phuket", "פוקט"], "DEL": ["delhi", "דלהי", "ניו דלהי"], "BOM": ["bombay", "mumbai", "מומבאי"],
    "TYO": ["tokyo", "טוקיו"], "HND": ["haneda", "טוקיו"], "NRT": ["narita", "טוקיו"], "SIN": ["singapore", "סינגפור"],
    "KIV": ["chisinau", "kishinev", "קישינב"], "TBS": ["tbilisi", "טביליסי"], "SOF": ["sofia", "סופיה"], "BEG": ["beograd", "belgrade", "בלגרד"],
    "ZAG": ["zagreb", "זאגרב"], "DBV": ["dubrovnik", "דוברובניק"], "SPU": ["split", "ספליט"], "TIV": ["tivat", "טיבט"], "TIA": ["tirana", "טירנה"],
    "KEF": ["reykjavik", "רייקיאוויק"], "MLA": ["valletta", "malta", "מלטה"], "MOW": ["moskva", "moscow", "מוסקווה"], "SVO": ["moskva", "sheremetyevo"],
    "RIX": ["riga", "ריגה"], "VNO": ["vilnius", "וילנה"], "TLL": ["tallinn", "טאלין"], "IEV": ["kyiv", "kiev", "קייב"], "KBP": ["kyiv", "kiev", "boryspil", "קייב"],
    "ETH": ["eilat", "אילת"], "ETM": ["ramon", "eilat", "רמון", "אילת"], "GDN": ["gdansk", "גדנסק"], "BRI": ["bari", "בארי"],
    "AGP": ["malaga", "מלגה"], "PMI": ["palma", "mallorca", "majorca", "מיורקה"], "IBZ": ["ibiza", "איביזה"], "SVQ": ["sevilla", "seville", "סביליה"],
    "VLC": ["valencia", "ולנסיה"], "TFS": ["tenerife", "טנריפה"], "LPA": ["gran canaria", "las palmas"], "DPS": ["bali", "denpasar", "באלי"],
    "CMB": ["colombo", "סרי לנקה"], "MLE": ["male", "maldives", "מלדיבים"], "CPT": ["cape town", "קייפטאון"], "JNB": ["johannesburg", "יוהנסבורג"],
}


def main():
    if not DAT.exists():
        print("downloading", URL)
        DAT.write_bytes(urllib.request.urlopen(URL, timeout=60).read())
    out = []
    for row in csv.reader(DAT.open(encoding="utf-8")):
        iata, typ = row[4], row[12]
        if typ != "airport" or len(iata) != 3 or iata == "\\N" or iata in GROUPS:
            continue
        out.append([iata, row[2], row[1], row[3], 1 if iata in POPULAR else 0, ALIASES.get(iata, [])])
    for code, city, name, country in EXTRA:
        out.append([code, city, name, country, 1 if code in POPULAR else 0, ALIASES.get(code, [])])
    for code, (city, country) in GROUPS.items():
        out.append([code, city, "All airports", country, 2, ALIASES.get(code, [])])
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} rows, {sum(1 for o in out if o[4] == 1)} popular, {sum(1 for o in out if o[5])} with aliases -> {OUT}")


main()
