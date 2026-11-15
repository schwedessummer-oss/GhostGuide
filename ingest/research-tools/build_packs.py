#!/usr/bin/env python3
"""Build compact "evidence packs" for fact extraction (no model tokens needed).

For each ingest/research/urls/<slug>.json ({"seed_no", "slug", "name", "urls": [{"url", "purpose"}]})
this fetches every URL (cached), keeps only the lines likely to carry facts
(fees, permits, rules, distances, seasons, access, closures, hazards) plus headings,
and writes ingest/research/packs/<slug>.md with numbered lines like  [P2 L17] text.

The extraction step reads only these packs, and every fact must quote one of
these lines verbatim, so verify_facts.py can check it mechanically.

Usage: python3 ingest/research-tools/build_packs.py [slug ...]   (no args = all)
"""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_text import fetch, page_text  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URLS = os.path.join(ROOT, "ingest", "research", "urls")
PACKS = os.path.join(ROOT, "ingest", "research", "packs")
PER_HIKE = 36000
MIN_PAGE = 2500

KW = re.compile(
    r"(\$|€|£|¥|₩|₹|\bUSD|\bNZD|\bAUD|\bCAD|\bCHF|\bNOK|\bSEK|\bISK|\bPEN|\bS/|\bCLP|\bARS|\bCOP|\bBRL|R\$|\bTZS|\bKES|\bNAD|\bZAR|\bMAD|\bUGX|\bNPR|\bINR|\bJPY|\bTWD|NT\$|\bKRW|\bCNY|\bRMB|\bMYR|\bRM\s?\d|\bIDR|\bRp\b|\bKGS|\bGEL|\bJOD|\bOMR|\bPGK|\bMWK|\bHKD|\bEUR|\bGBP|"
    r"fee|price|cost|ticket|pass\b|permit|lottery|reserv|booking|book |quota|limit|registration|regist|"
    r"\bdog|\bpet|drone|uav|camp|fire|stove|group size|people per|persons|max(imum)? of|"
    r"parking|car park|shuttle|bus\b|train|transport|road|trailhead|access|"
    r"\bmiles?\b|\bmi\b|\bkm\b|kilomet|\bfeet\b|\bft\b|elevation|altitude|gain|ascent|metres|meters|\bhours?\b|\bhrs?\b|\bdays?\b|nights?|round.?trip|one.?way|loop|"
    r"closed|closure|open(s|ed)? |season|month|january|february|march|april|may\b|june|july|august|september|october|november|december|"
    r"hazard|danger|warning|flood|heat|altitude sickness|avalanche|lightning|rockfall|tide|advisory|guide|operator|licen[cs]ed|mandatory|required|prohibit|not (permitted|allowed)|allowed|"
    r"tarifa|precio|entrada|permiso|cerrad|temporada|perros|acampar|fuego|grupo|estacionamiento|autob|guía|obligatori|"
    r"biglietto|tariff|prezzo|chiuso|cani|campeggio|fuoco|gruppo|parcheggio|"
    r"tarif|prix|billet|fermé|chiens|bivouac|feu\b|groupe|navette|"
    r"gebühr|eintritt|preis|gesperrt|hunde|zelten|feuer|gruppe|parkplatz|"
    r"preço|taxa|bilhete|fechad|cães|acampamento|fogo|estacionamento|"
    r"opłat|bilet|zamknię|psy|料金|入山|予約|閉鎖|許可|입장|예약|입산)",
    re.I,
)


def domain(url):
    return urllib.parse.urlparse(url).netloc.lower()


BOILER = re.compile(r"^(## )?(close|copy|menu|search|home|calendar|contact us|skip to|share|print|exiting|an official website|lock|more|back to top|toggle|open|login|sign in)\b", re.I)


def select_lines(text, seen):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    keep = set()
    for i, l in enumerate(lines):
        if BOILER.match(l) and len(l) < 60:
            continue
        has_num = bool(re.search(r"\d", l))
        if l.startswith("## ") and 12 <= len(l) < 140:
            keep.add(i)
        elif KW.search(l) and (len(l) >= 25 or has_num):
            keep.add(i)
            for j in (i - 1, i + 1):
                if 0 <= j < len(lines) and len(lines[j]) >= 25 and not BOILER.match(lines[j]):
                    keep.add(j)
    out = []
    for k in sorted(keep):
        key = lines[k].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append((k, lines[k]))
    return out


def build(slug):
    with open(os.path.join(URLS, slug + ".json")) as f:
        spec = json.load(f)
    out = [f"# Evidence pack: {spec.get('name', slug)} ({slug}, seed {spec.get('seed_no')})", ""]
    total = 0
    seen = set()
    n_pages = max(1, len(spec.get("urls", [])))
    per_page = max(MIN_PAGE, PER_HIKE // n_pages)
    for n, u in enumerate(spec.get("urls", []), start=1):
        url = u["url"] if isinstance(u, dict) else u
        purpose = u.get("purpose", "") if isinstance(u, dict) else ""
        rec = fetch(url, False)
        text, title = page_text(rec)
        out.append(f"## P{n} {url}")
        out.append(f"title: {title or '(none)'} | publisher domain: {domain(rec.get('url') or url)} | status: {rec.get('status')} | purpose: {purpose}")
        if not text:
            out.append("(no readable text: page failed, blocked by robots.txt, or rendered by JavaScript)")
            out.append("")
            continue
        used = 0
        lines = select_lines(text, seen)
        if sum(len(l) for _, l in lines) > per_page:
            # over budget: keep headings and lines with digits/currency first, in page order
            pri = [(i, l) for i, l in lines if l.startswith("## ") or re.search(r"\d|\$|€|£", l)]
            rest = [(i, l) for i, l in lines if (i, l) not in pri]
            keep, size = [], 0
            for i, l in pri + rest:
                if size + len(l) > per_page:
                    continue
                keep.append((i, l))
                size += len(l)
            lines = sorted(keep)
            out.append(f"(page trimmed to fit: {len(lines)} lines kept)")
        for i, line in lines:
            line = line[:900]
            out.append(f"[P{n} L{i}] {line}")
            used += len(line)
            total += len(line)
        out.append("")
    os.makedirs(PACKS, exist_ok=True)
    with open(os.path.join(PACKS, slug + ".md"), "w") as f:
        f.write("\n".join(out))
    return total


def main():
    slugs = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(URLS) if f.endswith(".json"))
    for s in slugs:
        try:
            print(f"{s}: {build(s)} chars")
        except Exception as e:  # keep going for the other hikes
            print(f"{s}: ERROR {e}")


if __name__ == "__main__":
    main()
