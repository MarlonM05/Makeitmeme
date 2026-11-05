#!/usr/bin/env python3
"""Erzeugt index.html (die Online-Version) aus src/giffig.html.

src/giffig.html ist die eigentliche Spielseite. Sie läuft auch als Claude-Artifact;
hier wird sie mit online.js (Supabase Realtime) zu einer normalen Webseite verpackt, die auf
GitHub Pages läuft. Nach jeder Änderung an src/giffig.html: python3 build.py
"""
import json, pathlib, re

root = pathlib.Path(__file__).resolve().parent
body = (root / "src" / "giffig.html").read_text(encoding="utf-8")
head = (
    "<!doctype html>\n<!-- Generiert von build.py aus src/giffig.html. Nicht direkt bearbeiten. -->\n"
    '<html lang="de"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<meta name="description" content="Giffig – das Meme-Partyspiel mit GIFs. Code teilen, Captions schreiben, abstimmen.">'
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js"></script>'
    '<script src="memes.js"></script><script src="online.js"></script></head><body>\n'
)
(root / "index.html").write_text(head + body + "\n</body></html>\n", encoding="utf-8")
print("index.html gebaut")

# catalog.json: Liste aller eingebauten Bilder für die Admin-Seite (Bilder ansehen, aus dem Spiel nehmen).
def read_catalog():
    src = (root / "src" / "giffig.html").read_text(encoding="utf-8")
    a = src.index("const GIFS = [") + len("const GIFS = [")
    b = src.index("\n];", a)
    body = re.sub(r"^\s*//.*$", "", src[a:b], flags=re.M)
    items = [{"id": e[0], "name": e[1], "tags": e[2] if len(e) > 2 and isinstance(e[2], str) else ""} for e in json.loads("[" + body + "]")]
    mem = root / "memes.js"
    if mem.exists():  # eigene Memes von Hand (memes.js) gehören auch dazu
        text = mem.read_text(encoding="utf-8")
        text = text[text.index("GIFFIG_EXTRA"):] if "GIFFIG_EXTRA" in text else ""
        known = {i["id"] for i in items}
        for m in re.finditer(r'\[\s*"([A-Za-z0-9._-]{1,80})"\s*,\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?\s*\]', text):
            if m.group(1) not in known:
                items.append({"id": m.group(1), "name": m.group(2)[:40], "tags": re.sub(r"[^dxv]", "", m.group(3) or "")})
    return items

catalog = read_catalog()
(root / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("catalog.json gebaut:", len(catalog), "Bilder")
