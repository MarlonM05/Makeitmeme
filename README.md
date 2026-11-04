# Giffig – das Meme-Partyspiel mit GIFs

Ein Mehrspieler-Spiel im Stil von „Make It Meme“, nur mit GIFs: Einer erstellt ein Spiel und teilt den
4-Buchstaben-Code, alle wählen aus 3 GIFs, schreiben eine Caption und bewerten die Memes der anderen
anonym (😐 bis 💀). Am Ende gibt es ein Podium und das Meme des Spiels.

**Spielen:** https://marlonm05.github.io/Makeitmeme/ (sobald GitHub Pages aktiviert ist, siehe unten)

## Features

- 117 GIFs von [GIPHY](https://giphy.com): 75 internationale Klassiker und 42 deutsche Memes
  (Bernd das Brot, Heinz Comedy, Dittsche, Tagesschau, Horst Lichter, Deutsche Bahn …)
- GIF-Auswahl: Alle, nur Deutsch oder nur International
- Modi: Klassisch (jeder eigene GIFs), Duell (alle dasselbe GIF), Mix
- 2 Neu-Würfe pro Runde, 3 Textstile, „💡 Idee“-Knopf mit deutschen Meme-Situationen
- Fliegende Emoji-Reaktionen beim Abstimmen, bis zu 8 Spieler
- Ruhmeshalle für die besten Memes, Übungsmodus für alleine

## Wie es ohne Server funktioniert

Der Browser, der ein Spiel erstellt, ist der Spielserver. Die anderen verbinden sich direkt mit ihm
(WebRTC über [PeerJS](https://peerjs.com) und dessen kostenlosen Vermittlungsserver). Deshalb reicht
statisches Hosting wie GitHub Pages. Der Host muss sein Fenster offen lassen.

## Dateien

| Datei | Zweck |
|---|---|
| `src/giffig.html` | Die Spielseite (läuft auch als Claude-Artifact mit den Fähigkeiten `room`, `db`, `user`) |
| `p2p.js` | Ersetzt die Claude-Fähigkeiten durch PeerJS und eine lokale Ruhmeshalle |
| `index.html` | Generiert von `build.py`, das ist die Seite auf GitHub Pages |
| `g/` | Die GIFs als 200px-WebP von GIPHY |
| `fetch_gifs.sh` | Lädt fehlende GIFs neu von GIPHY |

Nach Änderungen an `src/giffig.html`: `python3 build.py`

## GitHub Pages einschalten (einmalig)

Settings → Pages → Build and deployment → Source: **Deploy from a branch** → Branch: **main**, Ordner **/ (root)** → Save.
Nach ein bis zwei Minuten läuft das Spiel unter https://marlonm05.github.io/Makeitmeme/.
