"""Find an airline's official website: from our own list, else from Wikidata (free, no key), else say plainly that it can't be found.

Used for airlines we have no address for (a brand-new carrier such as Animawings): the results page asks `/api/airline-site` and either
gets a real website to send you to, or "not found" -- never a guess and never a search-engine page.

Lookup order for `resolve(code, name)`:
  1. AIRLINE_SITES (links.py)                                     -> source "list"
  2. the cache file (positive answers 90 days, misses 3 days)     -> source "cache"
  3. Wikidata by IATA code: the active airline with that designator and an official website (P229 + P856, not dissolved P576)
  4. ...or by exact English name (label) with an official website (both in one query)
The address must be https, on a public host, and answer (a bot wall's 401/403/429 still counts: the site exists) or it is not used.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .links import AIRLINE_SITES

SPARQL = "https://query.wikidata.org/sparql"
UA = "Skyhop-flightagent/0.1 (https://github.com/alon24/AiTravelSearcher; airline official-website lookup, cached)"   # Wikimedia asks clients to identify themselves
HIT_TTL = 90 * 86400
MISS_TTL = 3 * 86400
_lock = threading.Lock()
_mem: dict[str, dict] = {}
_loaded = False

_CODE = re.compile(r"^[A-Z0-9]{2,3}$")
_NAME = re.compile(r"^[\w .&'\-]{2,80}$")          # letters, digits, space and . & ' - : nothing that could break out of a SPARQL string


def cache_path() -> Path:
    base = os.environ.get("FLIGHTAGENT_CACHE_DB", ".cache/offers.sqlite")
    return Path(base).parent / "airline_sites.json"


def _load() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        _mem.update(json.loads(cache_path().read_text()))
    except Exception:
        pass


def _save() -> None:
    try:
        p = cache_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(_mem))
    except Exception:
        pass


def _key(code: str, name: str) -> str:
    return f"{code.upper()}|{name.lower()}"          # both: the same code seen under a different name is a different question


def _norm(s: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", s.lower()) if w and w not in {"air", "airlines", "airways", "the", "of", "aviation", "flight"}}


def public_https_url(url: str) -> str | None:
    """The URL as https on a public host, or None. Keeps a poisoned data source from pointing us at localhost or the docker network."""
    try:
        u = urlparse(url.strip())
        if u.scheme not in ("http", "https") or not u.hostname or "." not in u.hostname or u.username or u.password:
            return None
        for info in socket.getaddrinfo(u.hostname, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return None
        return f"https://{u.netloc}{u.path or '/'}"
    except Exception:
        return None


def site_answers(url: str, timeout: float = 8.0) -> bool:
    """Does the site exist? Redirects are not followed (they could lead somewhere private); a 3xx counts, and so do the walls
    big airlines put up against automated visitors (401, 403, 405, 429)."""
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=False, headers={"User-Agent": "Mozilla/5.0 (compatible; Skyhop)"})
        return r.status_code < 400 or r.status_code in (401, 403, 405, 429)
    except Exception:
        return False


class Unavailable(Exception):
    """Wikidata could not be asked right now (down, or asking us to slow down). Says nothing about whether the airline has a website."""


_blocked_until = 0.0        # Wikidata answered 429 ("slow down"): do not ask again before this time
_last_query = 0.0
MIN_GAP = 1.2               # seconds between our queries (Wikidata's service is shared and rate-limited)


def _query(sparql: str, timeout: float = 20.0) -> list[dict]:
    global _blocked_until, _last_query
    with _lock:
        now = time.time()
        if now < _blocked_until:
            raise Unavailable(f"Wikidata asked us to wait {int(_blocked_until - now)}s")
        wait = _last_query + MIN_GAP - now
        if wait > 0:
            time.sleep(wait)
        _last_query = time.time()
    try:
        r = httpx.get(SPARQL, params={"query": sparql, "format": "json"}, timeout=timeout,
                      headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    except httpx.HTTPError as e:
        raise Unavailable(str(e)) from e
    if r.status_code == 429 or r.status_code >= 500:
        try:
            wait_s = int(r.headers.get("Retry-After", "60"))
        except ValueError:
            wait_s = 60
        _blocked_until = time.time() + min(max(wait_s, 5), 3600)     # honour Retry-After (Wikimedia can ask for ~17 minutes); asking sooner extends the penalty
        raise Unavailable(f"Wikidata answered {r.status_code}")
    r.raise_for_status()
    return r.json()["results"]["bindings"]


def _pick(rows: list[dict], name: str) -> str | None:
    """Best official website among rows. A row only counts if its label shares a word with the airline's name: an IATA code alone is not proof
    (the same two letters have belonged to several airlines), and a wrong airline's site is worse than none. Then rows found by code beat rows
    found by name, then the closest label."""
    cands = [(int(b.get("byCode", {}).get("value", "0")), b.get("aLabel", {}).get("value", ""), b["site"]["value"]) for b in rows if b.get("site")]
    want = _norm(name)
    if want:
        cands = [c for c in cands if want & _norm(c[1])]
    if not cands:
        return None
    return sorted(cands, key=lambda c: (-c[0], -len(want & _norm(c[1]))))[0][2]


def wikidata_site(code: str, name: str) -> str | None:
    """ONE query for both ways of finding the airline: by IATA designator (active airlines only) and by exact English name."""
    parts = []
    if code and _CODE.match(code):
        parts.append('{ ?a wdt:P229 "%s"; wdt:P856 ?site. BIND(1 AS ?byCode) }' % code)
    if name and _NAME.match(name):
        parts.append('{ ?a rdfs:label "%s"@en; wdt:P856 ?site. BIND(0 AS ?byCode) }' % name.replace('"', ""))
    if not parts:
        return None
    rows = _query('SELECT ?a ?aLabel ?site ?byCode WHERE { %s FILTER NOT EXISTS { ?a wdt:P576 ?e } '
                  'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 12' % " UNION ".join(parts))
    return _pick(rows, name)


def resolve(code: str, name: str) -> dict:
    """{"url": str | None, "source": "list" | "cache" | "wikidata" | None, ["unavailable": True]}. Never raises. `unavailable` means the lookup could not
    be made right now (not that the airline has no site): it is not cached, and the page offers to try again."""
    code = (code or "").strip().upper()
    name = (name or "").strip()
    if code in AIRLINE_SITES:
        return {"url": AIRLINE_SITES[code], "source": "list"}
    if not (code and _CODE.match(code)) and not (name and _NAME.match(name)):
        return {"url": None, "source": None}
    with _lock:
        _load()
        hit = _mem.get(_key(code, name))
    if hit and time.time() - hit["at"] < (HIT_TTL if hit.get("url") else MISS_TTL):
        return {"url": hit.get("url"), "source": "cache" if hit.get("url") else None}
    url = None
    try:
        found = wikidata_site(code, name)
        safe = public_https_url(found) if found else None
        url = safe if safe and site_answers(safe) else None
    except Unavailable:
        return {"url": None, "source": None, "unavailable": True}     # could not ask: say so, and do not remember it as "no website"
    except Exception:
        return {"url": None, "source": None, "unavailable": True}
    with _lock:
        _mem[_key(code, name)] = {"url": url, "at": time.time(), "name": name}
        _save()
    return {"url": url, "source": "wikidata" if url else None}
