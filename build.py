#!/usr/bin/env python3
"""Erzeugt index.html (die Online-Version) aus src/giffig.html.

src/giffig.html ist die eigentliche Spielseite. Sie läuft auch als Claude-Artifact;
hier wird sie mit online.js (Supabase Realtime) zu einer normalen Webseite verpackt, die auf
GitHub Pages läuft. Nach jeder Änderung an src/giffig.html: python3 build.py
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent
body = (root / "src" / "giffig.html").read_text(encoding="utf-8")
head = (
    "<!doctype html>\n<!-- Generiert von build.py aus src/giffig.html. Nicht direkt bearbeiten. -->\n"
    '<html lang="de"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<meta name="description" content="Giffig – das Meme-Partyspiel mit GIFs. Code teilen, Captions schreiben, abstimmen.">'
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js"></script>'
    '<script src="online.js"></script></head><body>\n'
)
(root / "index.html").write_text(head + body + "\n</body></html>\n", encoding="utf-8")
print("index.html gebaut")
