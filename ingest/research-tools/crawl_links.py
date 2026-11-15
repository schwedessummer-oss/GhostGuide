#!/usr/bin/env python3
"""Add relevant same-site links to each hike's URL list (one level, no model tokens).

For every page already in ingest/research/urls/<slug>.json, parse its links and keep
links on the same site whose URL or link text mentions permits, fees, tickets,
bookings, rules, pets/dogs, drones, camping, alerts/closures, safety, getting
there / transport / parking, or words from the hike's name. Fetches each candidate
(robots.txt respected, cached) and adds up to MAX_ADD pages that load with text.

Usage: python3 ingest/research-tools/crawl_links.py [slug ...]
"""
import json
import os
import re
import sys
import urllib.parse
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_text import fetch, page_text  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URLS = os.path.join(ROOT, "ingest", "research", "urls")
MAX_ADD = 6
KEYS = re.compile(r"permit|fee|price|pricing|ticket|tariff|booking|book|reserv|lottery|rules|regulation|pets?\b|dogs?|drone|camp|campsite|hut|alert|closure|condition|safety|getting.?there|directions|transport|shuttle|bus|parking|access|plan.?your.?visit|faq|trail|track|hike|hiking|route|walk|tarifa|precio|entrada|permiso|biglietto|tarif|preise|eintritt|regolamento|normas|reglement", re.I)
SKIP = re.compile(r"\.(jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|ics)(\?|$)|/(login|signin|account|cart|checkout|search|news|blog|press|media|careers|jobs|shop)\b|facebook|twitter|instagram|youtube|mailto:|tel:|javascript:", re.I)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self._href, self._text = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            self.links.append((self._href, " ".join("".join(self._text).split())))
            self._href = None


def site(netloc):
    parts = netloc.lower().split(".")
    return ".".join(parts[-3:]) if len(parts) > 2 and len(parts[-1]) == 2 and len(parts[-2]) <= 3 else ".".join(parts[-2:])


def crawl(slug):
    path = os.path.join(URLS, slug + ".json")
    spec = json.load(open(path))
    have = {u["url"].split("#")[0] for u in spec["urls"]}
    name_words = [w for w in re.findall(r"[a-z]{4,}", (spec.get("name") or "").lower()) if w not in {"trail", "track", "trek", "walk", "circuit", "route", "mount", "national", "park"}]
    scored = {}
    for u in list(spec["urls"]):
        rec = fetch(u["url"], False)
        if not rec.get("body"):
            continue
        base = rec.get("url") or u["url"]
        p = Links()
        try:
            p.feed(rec["body"])
        except Exception:
            continue
        for href, text in p.links:
            absu = urllib.parse.urljoin(base, href).split("#")[0]
            pu = urllib.parse.urlparse(absu)
            if pu.scheme not in ("http", "https") or SKIP.search(absu) or absu in have:
                continue
            if site(pu.netloc) != site(urllib.parse.urlparse(base).netloc):
                continue
            hay = f"{absu} {text}".lower()
            score = len(KEYS.findall(hay)) + 3 * sum(1 for w in name_words if w in hay)
            if score >= 2:
                scored[absu] = max(scored.get(absu, 0), score)
    added = 0
    for absu, _ in sorted(scored.items(), key=lambda kv: -kv[1]):
        if added >= MAX_ADD:
            break
        rec = fetch(absu, False)
        text, title = page_text(rec)
        if rec.get("status") == 200 and len(text) > 500:
            spec["urls"].append({"url": absu, "purpose": "crawled"})
            added += 1
    json.dump(spec, open(path, "w"), indent=1)
    return added


def main():
    slugs = sys.argv[1:] or sorted(f[:-5] for f in os.listdir(URLS) if f.endswith(".json"))
    for s in slugs:
        try:
            print(s, crawl(s), flush=True)
        except Exception as e:
            print(s, "ERROR", e, flush=True)


if __name__ == "__main__":
    main()
