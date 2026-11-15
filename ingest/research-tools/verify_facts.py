#!/usr/bin/env python3
"""Mechanical verification of curated facts (replaces an LLM re-reading every page).

For every fact in ingest/curated/<slug>.yaml it checks, against the cached copy of
fact.source_url:
  1. quote_found      evidence.quote is a verbatim (whitespace-normalised) substring of the page text
  2. numbers_match    every number in the value appears in the quote, or is a stated
                      miles->km / feet->m conversion of a number in the quote
  3. own_words        no 10-word run of note/how_to_apply/parking/... is copied from the page
  4. allowed_source   the source domain is not a banned (non-official / proprietary) site
Facts passing all checks get `verified: true`; others get `verified: false` and
`verify_reason: [...]`. Only verified facts are loaded by the pipeline.

Usage: python3 ingest/research-tools/verify_facts.py [slug ...]   (no args = all)
Writes ingest/research/verify-report.json.
"""
import json
import os
import re
import sys
import urllib.parse

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_text import fetch, page_text  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CUR = os.path.join(ROOT, "ingest", "curated")
REPORT = os.path.join(ROOT, "ingest", "research", "verify-report.json")

BANNED = re.compile(r"(alltrails|komoot|gaiagps|wikiloc|strava|outdooractive|fatmap|faroutguides|tripadvisor|google\.|goo\.gl|reddit|wikipedia\.org|wikivoyage\.org|blogspot|wordpress\.com|medium\.com|lonelyplanet|getyourguide|viator|bookatrekking|fodors|rei\.com|hikingproject|trailforks|caltopo|onxmaps|yamap|yamareco|hikingbiji)", re.I)
TEXT_FIELDS = ("note", "how_to_apply", "parking", "trailhead_access", "public_transport", "season_note")
NO_NUMBER_CHECK = {"best_months", "official_url", "licensed_operator_list_url", "permit_required", "route_type", "access_mode", "entry_fee_none"}
_cache = {}


def norm(s):
    s = str(s).replace(" ", " ").replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace("–", "-").replace("—", "-").replace("−", "-")
    return re.sub(r"\s+", " ", s).strip().lower()


def page(url):
    if url not in _cache:
        rec = fetch(url, False)
        text, _ = page_text(rec)
        _cache[url] = norm(text)
    return _cache[url]


def numbers(o, skip_keys=("months", "currency", "unit", "audience", "kind", "scale", "basis", "valid_from", "valid_to", "official_url", "url")):
    out = []
    if isinstance(o, bool) or o is None:
        return out
    if isinstance(o, (int, float)):
        return [float(o)]
    if isinstance(o, dict):
        for k, v in o.items():
            if k not in skip_keys and k not in TEXT_FIELDS and k != "name":
                out += numbers(v)
    elif isinstance(o, list):
        for v in o:
            out += numbers(v)
    return out


def _interpretations(tok):
    tok = tok.replace(" ", "")
    outs = set()
    if "," in tok and "." in tok:
        dec = "," if tok.rfind(",") > tok.rfind(".") else "."
        th = "." if dec == "," else ","
        outs.add(tok.replace(th, "").replace(dec, "."))
    elif "," in tok or "." in tok:
        sep = "," if "," in tok else "."
        parts = tok.split(sep)
        outs.add(tok.replace(sep, ""))  # thousands separator reading
        if len(parts) == 2:
            outs.add(parts[0] + "." + parts[1])  # decimal reading
    else:
        outs.add(tok)
    vals = []
    for o in outs:
        try:
            vals.append(float(o))
        except ValueError:
            pass
    return vals


def quote_numbers(q):
    vals = []
    for m in re.findall(r"\d+(?:[.,\s]\d+)*", q):
        vals += _interpretations(m)
    for m in re.findall(r"\d+(?:[.,]\d+)?", q):  # also each number on its own
        vals += _interpretations(m)
    return vals


def number_ok(v, qnums):
    for q in qnums:
        if abs(q - v) < 1e-6:
            return True
        for f in (1.609344, 0.3048, 1 / 60.0, 24.0):  # mi->km, ft->m, minutes->hours, days->hours
            if v and abs(q * f - v) / abs(v) < 0.02:
                return True
    return False


def shingles(text, n=10):
    w = norm(text).split()
    return {" ".join(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}


def check(fact):
    reasons = []
    url = fact.get("source_url") or ""
    if not url.startswith("http"):
        return ["no_source_url"]
    if BANNED.search(urllib.parse.urlparse(url).netloc + urllib.parse.urlparse(url).path[:30]):
        reasons.append("banned_source")
    ev = fact.get("evidence") or {}
    quote = ev.get("quote") if isinstance(ev, dict) else None
    text = page(url)
    if not text:
        return reasons + ["page_unavailable"]
    if not quote:
        reasons.append("no_quote")
    elif norm(quote) not in text:
        reasons.append("quote_not_found")
    elif fact.get("field") not in NO_NUMBER_CHECK:
        qn = quote_numbers(norm(quote))
        for v in numbers(fact.get("value")):
            if not number_ok(v, qn):
                reasons.append(f"number_not_in_quote:{v:g}")
                break
    for key in TEXT_FIELDS:
        vals = [fact.get(key)]
        if isinstance(fact.get("value"), dict):
            vals.append(fact["value"].get(key))
        if fact.get("field") in TEXT_FIELDS and isinstance(fact.get("value"), str):
            vals.append(fact["value"])
        for t in vals:
            if isinstance(t, str) and len(t.split()) >= 10 and shingles(t) & shingles(text_raw_for(url)):
                reasons.append(f"copied_wording:{key}")
                break
    return reasons


def text_raw_for(url):
    return page(url)


def main():
    slugs = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(CUR) if f.endswith(".yaml"))
    report = {}
    if os.path.exists(REPORT):
        report = json.load(open(REPORT))
    for slug in slugs:
        path = os.path.join(CUR, slug + ".yaml")
        doc = yaml.safe_load(open(path)) or {}
        facts = doc.get("facts") or []
        ok = bad = 0
        reasons_count = {}
        for f in facts:
            r = check(f)
            f["verified"] = not r
            if r:
                f["verify_reason"] = r
                bad += 1
                for x in r:
                    k = x.split(":")[0]
                    reasons_count[k] = reasons_count.get(k, 0) + 1
            else:
                f.pop("verify_reason", None)
                ok += 1
        doc["mechanical_check"] = {"verified": ok, "failed": bad, "reasons": reasons_count}
        with open(path, "w") as fh:
            yaml.safe_dump(doc, fh, sort_keys=False, allow_unicode=True, width=1000)
        report[slug] = doc["mechanical_check"]
        print(f"{slug}: {ok} verified, {bad} failed {reasons_count or ''}")
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    json.dump(report, open(REPORT, "w"), indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
