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

## Wie das Mehrspielen funktioniert

Die Seite liegt auf GitHub Pages (reines Frontend). Die Spieler sprechen über **Supabase Realtime**
(WebSocket über Port 443, funktioniert auch in Schul-, Firmen- und Handy-Netzen). Es gibt keine
eigene Datenbank und keine Tabellen: jedes Spiel ist ein Kanal `giffig-<CODE>`, über den alle ihren
Zustand per Broadcast teilen. Der Spieler, der das Spiel erstellt, führt die Spiellogik aus
(Host-Wechsel passiert automatisch, wenn er geht). Der Schlüssel in `online.js` ist ein öffentlicher
Browser-Schlüssel und darf im Code stehen.

Hinweise:
- Wer den 4-Buchstaben-Code kennt, kann mitlesen. Das Spiel ist für Freundesrunden gedacht.
- Gratis-Tarif: 200 gleichzeitige Verbindungen, 100 Nachrichten pro Sekunde.
- Gratis-Projekte pausiert Supabase nach einer Woche ohne Aktivität. Dann im Supabase-Dashboard auf „Restore“ klicken.

## Dateien

| Datei | Zweck |
|---|---|
| `src/giffig.html` | Die Spielseite (läuft auch als Claude-Artifact mit den Fähigkeiten `room`, `db`, `user`) |
| `admin.html` | Admin-Seite: Bilder hochladen und verwalten |
| `supabase/functions/giffig-admin/` | Geschützter Admin-Server (Supabase Edge Function) |
| `memes.js` | Eigene Memes von Hand (Liste), siehe oben |
| `add_meme.py` | Hilfsskript zum Hinzufügen eigener Bilder |
| `online.js` | Ersetzt die Claude-Fähigkeiten durch Supabase Realtime und eine lokale Ruhmeshalle |
| `index.html` | Generiert von `build.py`, das ist die Seite auf GitHub Pages |
| `g/` | GIFs (200px-WebP von GIPHY) und Vorlagen (`if-*.webp`, von Imgflip) |
| `fetch_gifs.sh` | Lädt fehlende GIPHY-GIFs neu (Vorlagen liegen fest im Repo) |

Nach Änderungen an `src/giffig.html`: `python3 build.py`

## Admin-Seite (nur für dich)

`admin.html` (online unter `…/Makeitmeme/admin.html`) ist deine Verwaltung: Bilder per Drag & Drop hochladen,
Namen und Tags ändern, Bilder ausblenden oder löschen. Hochgeladene Bilder erscheinen nach dem Neuladen im Spiel.

- **Zugang:** nur mit deinem Admin-Passwort. Die Seite selbst ist für jeden aufrufbar, aber ohne Passwort kann man
  nichts hochladen, ändern oder löschen. Das prüft der Server (`supabase/functions/giffig-admin`), nicht der Browser.
- **Ersteinrichtung:** Beim ersten Öffnen fragt die Seite nach einem Einrichtungs-Code. Den erzeugt man in Supabase (SQL-Editor):
  ```sql
  insert into public.admin_setup_tokens (token_hash, expires_at)
  values (encode(sha256(convert_to('DEIN-CODE','utf8')),'hex'), now() + interval '2 hours');
  ```
  Mit dem Code legst du dein Passwort fest (mindestens 12 Zeichen). Der Code gilt einmal. **Passwort vergessen?**
  `delete from public.admin_config;` ausführen und einen neuen Code anlegen, dann neu einrichten.
- **Schutz:** Das Passwort liegt nur als Hash in der Datenbank. Nach 8 Fehlversuchen pro Adresse in 15 Minuten
  (oder 60 pro Stunde insgesamt) ist die Anmeldung kurz gesperrt. Anmeldungen laufen nach 8 Stunden ab.
- **Dateien:** Fotos und PNGs werden im Browser auf höchstens 480 Pixel verkleinert und als WebP gespeichert.
  GIFs und animierte WebPs bleiben unverändert (bis 6 MB). Alles liegt im öffentlichen Supabase-Speicher `memes`.
- **Gratis-Limits:** Speicher 1 GB, Datenverkehr 5 GB pro Monat. Kleine Bilder halten das lange aus.

## Texte im Bild verschieben

Im Spiel (und im Übungsmodus) kannst du beide Texte im Vorschaubild mit Maus oder Finger an eine andere Stelle ziehen,
oder mit den Pfeiltasten verschieben (Umschalt = größere Schritte). „Texte zurücksetzen“ stellt die Standardposition her.
Die anderen Spieler sehen die Texte an genau deiner Position. Positionen werden in Prozent der Bildfläche gespeichert.

## Eigene Memes, Fotos und GIFs von Hand hinzufügen (ohne Admin-Seite)

**Ohne Programmieren, nur im Browser auf GitHub:**
1. Öffne im Repo den Ordner `g/`, klick auf **Add file → Upload files** und lade dein Bild hoch
   (`.webp`, `.gif`, `.jpg` oder `.png`, am besten unter 1 MB, ca. 400 Pixel breit reicht). Dann **Commit changes**.
2. Öffne `memes.js`, klick auf den Stift (Edit) und trag eine Zeile ein:
   ```js
   ["mein-foto.jpg", "Mein Foto", "d"],
   ```
   Erstes Feld ist der Dateiname, dann der Anzeigename, dann die Tags. Dann **Commit changes**.
3. Nach 1 bis 2 Minuten ist es online. Seite neu laden. Alle Mitspieler müssen neu laden, damit sie dieselbe Liste haben.

Tags (optional, kombinierbar): `d` deutsch, `x` derb (nur mit „Derbe Memes“), `v` Vorlage/Foto (erscheint im Topf „Vorlagen“). Ohne Tag landet es im Topf „International“.

**Mit dem Hilfsskript (verkleinert die Bilder und trägt sie selbst ein):**
```bash
pip install pillow
python3 add_meme.py foto.jpg --name "Mein Foto" --tags d
python3 add_meme.py lustig.gif katze.png --tags dx
git add -A && git commit -m "Neue Memes" && git push
```

**GIPHY-GIFs von Hand:** Lade das GIF bei GIPHY als WebP oder GIF herunter (oder nimm
`https://i.giphy.com/media/<ID>/200.webp`, die ID steht am Ende der GIPHY-Adresse) und füge es wie oben hinzu.
Bitte nur Bilder verwenden, an denen du die Rechte hast oder die du privat im Freundeskreis nutzt.

## GitHub Pages einschalten (einmalig)

Settings → Pages → Build and deployment → Source: **Deploy from a branch** → Branch: **main**, Ordner **/ (root)** → Save.
Nach ein bis zwei Minuten läuft das Spiel unter https://marlonm05.github.io/Makeitmeme/.
