# Giffig – das Meme-Partyspiel mit GIFs

Ein Mehrspieler-Spiel im Stil von „Make It Meme“, nur mit GIFs: Einer erstellt ein Spiel und teilt den
4-Buchstaben-Code, alle wählen aus 3 GIFs, schreiben eine Caption und bewerten die Memes der anderen
anonym (😐 bis 💀). Am Ende gibt es ein Podium und das Meme des Spiels.

**Spielen:** https://marlonm05.github.io/Makeitmeme/ (sobald GitHub Pages aktiviert ist, siehe unten)

## Features

- Über 270 GIFs und Bilder:
  - 120 internationale Reaktions-GIFs von [GIPHY](https://giphy.com) (WTF, Bruh, Cringe, Fails, Tiere …)
  - 55 deutsche Memes (Bernd das Brot, Heinz Comedy, Dittsche, Tagesschau, „Bruder muss los“, Deutsche Bahn …)
  - 81 klassische Meme-Vorlagen von [Imgflip](https://imgflip.com/memetemplates) (Drake, This Is Fine, Distracted Boyfriend …)
  - Derbe Memes (Mittelfinger, „Fuck you“, „Scheiß drauf“ …) nur, wenn der Host „Derbe Memes (ab 16)“ einschaltet
- Topf wählbar: Alle, nur Deutsch, nur International oder nur Vorlagen
- Modi: Klassisch (jeder eigene GIFs), Duell (alle dasselbe GIF), Mix
- 2 Neu-Würfe pro Runde, 3 Textstile, „💡 Idee“-Knopf mit deutschen Meme-Situationen (derbe Ideen bei Derb-Modus)
- Rundensieger bekommen +2 Bonuspunkte, Podium und Meme des Spiels am Ende
- Einladungslink (`…/Makeitmeme/#CODE`) füllt den Code automatisch aus
- Automatisches Neuverbinden, wenn die Verbindung kurz weg ist; Bildschirm bleibt im Spiel an
- Soundeffekte (abschaltbar), fliegende Emoji-Reaktionen, bis zu 8 Spieler
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
| `g/` | GIFs (200px-WebP von GIPHY) und Vorlagen (`if-*.webp`, von Imgflip) |
| `fetch_gifs.sh` | Lädt fehlende GIPHY-GIFs neu (Vorlagen liegen fest im Repo) |

Nach Änderungen an `src/giffig.html`: `python3 build.py`

## GitHub Pages einschalten (einmalig)

Settings → Pages → Build and deployment → Source: **Deploy from a branch** → Branch: **main**, Ordner **/ (root)** → Save.
Nach ein bis zwei Minuten läuft das Spiel unter https://marlonm05.github.io/Makeitmeme/.
