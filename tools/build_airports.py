"""Builds src/flightagent/web/airports.json from OpenFlights (ODbL) and OurAirports (public domain), plus our popularity
list and aliases.

    python tools/build_airports.py [airports.dat] [ourairports.csv]      # downloads what is missing

OpenFlights gives the names, time zones and coordinates; OurAirports (updated nightly) says which airports have
scheduled passenger flights today, and adds the scheduled ones OpenFlights lacks (BER, new airports).
Row format: [iata, city, airport name, country, rank, [aliases], service]
  rank: 0 normal, 1 popular, 2 city group.
  service: 0 no scheduled flights (air bases, closed fields), 1 scheduled flights, 2 a large airport with them.
Also writes web/airport_coords.json ({iata: [lat, lon]}, for putting a search on a MyMaps AI map; a city group sits at
its first airport) and data/airport_tz.json.
"""
import csv, io, json, sys, urllib.request
from collections import Counter
from pathlib import Path

URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat"
OA_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv"
OUT = Path(__file__).resolve().parents[1] / "src/flightagent/web/airports.json"
TZ_OUT = Path(__file__).resolve().parents[1] / "src/flightagent/data/airport_tz.json"
COORDS_OUT = OUT.with_name("airport_coords.json")
DAT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/airports.dat")
OA = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/ourairports.csv")

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

EXTRA_TZ = {"BER": "Europe/Berlin", "ROM": "Europe/Rome", "LON": "Europe/London", "PAR": "Europe/Paris", "NYC": "America/New_York",
            "MIL": "Europe/Rome", "STO": "Europe/Stockholm", "MOW": "Europe/Moscow", "TYO": "Asia/Tokyo", "WAS": "America/New_York",
            "CHI": "America/Chicago", "BUH": "Europe/Bucharest", "BJS": "Asia/Shanghai", "OSA": "Asia/Tokyo", "SAO": "America/Sao_Paulo",
            "BUE": "America/Argentina/Buenos_Aires"}

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
    "FNC": ["madeira", "מדירה"], "PXO": ["madeira"], "PDL": ["azores", "acores", "האיים האזוריים"], "TER": ["azores", "acores"],
    "HOR": ["azores", "acores"], "PIX": ["azores", "acores"], "SMA": ["azores", "acores"], "BER": ["berlin brandenburg"],
    "CMB": ["colombo", "סרי לנקה"], "MLE": ["male", "maldives", "מלדיבים"], "CPT": ["cape town", "קייפטאון"], "JNB": ["johannesburg", "יוהנסבורג"],
}


def fetch(path, url):
    if not path.exists():
        print("downloading", url)
        path.write_bytes(urllib.request.urlopen(url, timeout=120).read())
    return path.read_text(encoding="utf-8")


def main():
    openflights = [r for r in csv.reader(io.StringIO(fetch(DAT, URL)))
                   if r[12] == "airport" and len(r[4]) == 3 and r[4] != "\\N" and r[4] not in GROUPS]
    ours = {r["iata_code"]: r for r in csv.DictReader(io.StringIO(fetch(OA, OA_URL))) if len(r["iata_code"]) == 3}
    service = lambda r: 0 if not r or r["scheduled_service"] != "yes" else 2 if r["type"] == "large_airport" else 1
    # OurAirports has ISO country codes; name them as OpenFlights does, so a country's airports share one name.
    names = {}
    for r in openflights:
        if r[4] in ours:
            names.setdefault(ours[r[4]]["iso_country"], Counter())[r[3]] += 1
    country = {iso: c.most_common(1)[0][0] for iso, c in names.items()}

    # The same code in another country is a different airport (OpenFlights' AVR is Alverca, OurAirports' is in the US).
    same = lambda row: ours.get(row[4]) if country.get(ours.get(row[4], {}).get("iso_country")) == row[3] else None
    out, tz, coords = [], {}, {}
    for row in openflights:
        iata = row[4]
        out.append([iata, row[2], row[1], row[3], 1 if iata in POPULAR else 0, ALIASES.get(iata, []), service(same(row))])
        coords[iata] = [round(float(row[6]), 3), round(float(row[7]), 3)]
        if row[11] and row[11] != "\\N":
            tz[iata] = row[11]
    known = {o[0] for o in out}
    added = 0
    for iata, r in sorted(ours.items()):
        if iata in known or iata in GROUPS or not service(r) or r["iso_country"] not in country:
            continue
        out.append([iata, r["municipality"] or r["name"], r["name"], country[r["iso_country"]], 1 if iata in POPULAR else 0, ALIASES.get(iata, []), service(r)])
        coords[iata] = [round(float(r["latitude_deg"]), 3), round(float(r["longitude_deg"]), 3)]
        added += 1
    tz.update(EXTRA_TZ)
    for code, (city, country_name) in GROUPS.items():
        out.append([code, city, "All airports", country_name, 2, ALIASES.get(code, []), 2])
    CITY_AIRPORTS = json.loads((TZ_OUT.parent / "config.json").read_text())["city_airports"]
    for code in GROUPS:
        first = CITY_AIRPORTS.get(code, "").split(",")[0]
        if first in coords:
            coords[code] = coords[first]
    COORDS_OUT.write_text(json.dumps(coords, separators=(",", ":")), encoding="utf-8")
    TZ_OUT.parent.mkdir(parents=True, exist_ok=True)
    TZ_OUT.write_text(json.dumps(tz, separators=(",", ":")), encoding="utf-8")
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} rows ({added} from OurAirports only), {sum(1 for o in out if o[6])} with scheduled flights, "
          f"{sum(1 for o in out if o[4] == 1)} popular, {sum(1 for o in out if o[5])} with aliases -> {OUT}")


main()
