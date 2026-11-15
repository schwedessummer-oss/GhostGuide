#!/usr/bin/env python3
"""Create ingest/research/urls/<slug>.json from URLs already cited in seed + curated files."""
import json, os, sys, yaml
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEEDS = os.path.join(ROOT, "ingest", "seeds", "hikes"); CUR = os.path.join(ROOT, "ingest", "curated"); OUT = os.path.join(ROOT, "ingest", "research", "urls")
def walk_urls(o, acc):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("source_url", "official_url", "licensed_operator_list_url") and isinstance(v, str) and v.startswith("http"): acc.append(v)
            else: walk_urls(v, acc)
    elif isinstance(o, list):
        for v in o: walk_urls(v, acc)
for f in sorted(os.listdir(SEEDS)):
    slug = f[:-5]; seed = yaml.safe_load(open(os.path.join(SEEDS, f))) or {}
    urls = []
    if seed.get("official_url"): urls.append(seed["official_url"])
    walk_urls(seed.get("status") or {}, urls)
    cp = os.path.join(CUR, f)
    if os.path.exists(cp): walk_urls(yaml.safe_load(open(cp)) or {}, urls)
    seen, lst = set(), []
    for u in urls:
        if u not in seen: seen.add(u); lst.append({"url": u, "purpose": "cited"})
    json.dump({"seed_no": seed.get("seed_no"), "slug": slug, "name": seed.get("name"), "urls": lst}, open(os.path.join(OUT, slug + ".json"), "w"), indent=1)
    print(slug, len(lst))
