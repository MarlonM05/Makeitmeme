#!/usr/bin/env python3
"""Fügt eigene Bilder/GIFs als Memes hinzu: verkleinert sie, legt sie in g/ ab und trägt sie in memes.js ein.

Beispiele:
  python3 add_meme.py foto.jpg --name "Mein Foto" --tags d
  python3 add_meme.py lustig.gif katze.png --tags dx
Danach committen und pushen:  git add -A && git commit -m "Neue Memes" && git push
Braucht Pillow:  pip install pillow
"""
import argparse, pathlib, re, sys
from PIL import Image, ImageSequence

root = pathlib.Path(__file__).resolve().parent
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("dateien", nargs="+", help="Bilder oder GIFs")
ap.add_argument("--name", help="Anzeigename (nur bei einer einzelnen Datei, sonst der Dateiname)")
ap.add_argument("--tags", default="", help="d = deutsch, x = derb, v = Vorlage/Foto (kombinierbar, z. B. dx)")
ap.add_argument("--hoehe", type=int, default=240, help="maximale Höhe/Breite in Pixel (Standard 240)")
a = ap.parse_args()
if a.name and len(a.dateien) > 1:
    sys.exit("--name geht nur mit einer Datei.")

mem = root / "memes.js"
text = mem.read_text(encoding="utf-8")
(root / "g").mkdir(exist_ok=True)
lines = []
for f in a.dateien:
    src = pathlib.Path(f)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", src.stem).strip("-").lower() or "meme"
    out = f"my-{slug}.webp"
    if f'"{out}"' in text:
        print(f"übersprungen (gibt es schon): {out}"); continue
    im = Image.open(src)
    frames, durs = [], []
    for fr in ImageSequence.Iterator(im):
        fr = fr.convert("RGBA" if fr.mode in ("RGBA", "LA", "P") else "RGB")
        fr.thumbnail((a.hoehe * 2, a.hoehe * 2))
        frames.append(fr.copy()); durs.append(fr.info.get("duration", im.info.get("duration", 80)))
    dest = root / "g" / out
    if len(frames) > 1:
        frames[0].save(dest, "WEBP", save_all=True, append_images=frames[1:], duration=durs, loop=0, quality=70, method=4)
    else:
        frames[0].save(dest, "WEBP", quality=82)
    kb = dest.stat().st_size // 1024
    name = (a.name or src.stem).replace('"', "'")[:40]
    lines.append(f'  ["{out}", "{name}", "{a.tags}"],')
    print(f"ok: {out} ({kb} KB, {len(frames)} Bild{'er' if len(frames) > 1 else ''})" + ("  <- groß, besser kürzer/kleiner machen" if kb > 1500 else ""))
if lines:
    text = text.replace("window.GIFFIG_EXTRA = [\n", "window.GIFFIG_EXTRA = [\n" + "\n".join(lines) + "\n", 1)
    mem.write_text(text, encoding="utf-8")
    print("memes.js aktualisiert. Jetzt committen und pushen.")
