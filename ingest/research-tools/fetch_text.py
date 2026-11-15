#!/usr/bin/env python3
"""Fetch an official web page and print its readable text (for fact research).

Usage:  python3 -I ingest/research-tools/fetch_text.py URL [--grep REGEX] [--max CHARS]

- Sends an identifying User-Agent and checks robots.txt before fetching.
- Caches responses under ingest/.research-cache/ (git-ignored) so each page is
  fetched once; re-runs read the cache. Use --refresh to refetch.
- Prints: final URL, HTTP status, page <title>, a SHA-256 fingerprint of the
  normalised text, then the text (script/style/nav removed, whitespace collapsed).
- --grep prints only lines matching the regex (case-insensitive) with 1 line of context.

This tool never logs in, never submits forms and never touches booking flows.
"""
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser

UA = "GhostGuideResearch/0.1 (+https://ghost-guide.vercel.app; fact checking for a hiking guide)"
CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".research-cache")


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "iframe"}
    BLOCK = {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "br", "section", "article", "table", "dt", "dd", "td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.title, self._in_title = [], 0, "", False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag in ("h1", "h2", "h3", "h4"):
            self.out.append("## ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self._in_title = False
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if not self.skip:
            self.out.append(data)


def robots_ok(url: str) -> bool:
    p = urllib.parse.urlparse(url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        req = urllib.request.Request(f"{p.scheme}://{p.netloc}/robots.txt", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            rp.parse(r.read().decode("utf-8", "replace").splitlines())
    except Exception:
        return True  # no robots.txt reachable: allowed
    return rp.can_fetch(UA, url) or rp.can_fetch("*", url)


def fetch(url: str, refresh: bool):
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()[:24]
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path) and not refresh:
        with open(path) as f:
            return json.load(f)
    if not robots_ok(url):
        return {"url": url, "status": "robots_disallowed", "body": ""}
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read(6_000_000)
            ctype = r.headers.get("Content-Type", "")
            charset = r.headers.get_content_charset() or "utf-8"
            rec = {"url": r.geturl(), "status": r.status, "ctype": ctype, "body": raw.decode(charset, "replace") if "pdf" not in ctype else "", "pdf": "pdf" in ctype, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            if rec["pdf"]:
                pdf_path = os.path.join(CACHE, key + ".pdf")
                with open(pdf_path, "wb") as f:
                    f.write(raw)
                rec["pdf_path"] = pdf_path
    except urllib.error.HTTPError as e:
        rec = {"url": url, "status": e.code, "body": "", "error": str(e)}
    except Exception as e:  # network error
        rec = {"url": url, "status": "error", "body": "", "error": str(e)}
    with open(path, "w") as f:
        json.dump(rec, f)
    time.sleep(1.0)  # be polite between live fetches
    return rec


def page_text(rec):
    """Readable text of a fetched record ('' if none). PDFs via pdftotext."""
    if rec.get("pdf") and rec.get("pdf_path"):
        import subprocess
        try:
            out = subprocess.run(["pdftotext", "-layout", rec["pdf_path"], "-"], capture_output=True, timeout=60).stdout.decode("utf-8", "replace")
        except Exception:
            return "", ""
        out = re.sub(r"[ \t\r\f\v]+", " ", out)
        return re.sub(r"\n\s*\n+", "\n", out).strip(), "PDF"
    if not rec.get("body"):
        return "", ""
    p = _Text()
    p.feed(rec["body"])
    text = html.unescape("".join(p.out))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    return text, p.title.strip()


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    url = args[0]
    grep = args[args.index("--grep") + 1] if "--grep" in args else None
    mx = int(args[args.index("--max") + 1]) if "--max" in args else 40000
    rec = fetch(url, "--refresh" in args)
    print(f"URL: {rec.get('url')}\nSTATUS: {rec.get('status')}")
    if "--head" in args:
        text, title = page_text(rec)
        print(f"TITLE: {title}\nTEXT_CHARS: {len(text)}")
        return
    if rec.get("pdf"):
        print(f"PDF saved at {rec.get('pdf_path')} (extract with: pdftotext <path> - | head)")
        return
    if not rec.get("body"):
        print(f"ERROR: {rec.get('error', 'empty body')}")
        return
    p = _Text()
    p.feed(rec["body"])
    text = html.unescape("".join(p.out))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    print(f"TITLE: {p.title.strip()}\nFINGERPRINT: sha256:{hashlib.sha256(text.encode()).hexdigest()[:32]}\nFETCHED_AT: {rec.get('fetched_at', 'cache')}\n---")
    if grep:
        lines = text.splitlines()
        rx = re.compile(grep, re.I)
        shown = set()
        for i, line in enumerate(lines):
            if rx.search(line):
                for j in range(max(0, i - 1), min(len(lines), i + 2)):
                    if j not in shown:
                        print(lines[j])
                        shown.add(j)
                print("…")
    else:
        print(text[:mx])


if __name__ == "__main__":
    main()
