# mapq.at

Fotografie-Webseite von Matteo Hanser (mapq.raw), ausgeliefert über GitHub Pages von `main`.
Eine Seite: `index.html`. Google-Drive-Fotoordner: Button „Ordner“ in der Kopfzeile, Liste im Dialog `#ordner` (auch direkt über mapq.at/#ordner). `bilder.html` leitet nur weiter. Fotos in `fotos/` (groß, 1600 px lange Kante) und `fotos/klein/` (760 px). Jedes Motiv nur einmal: kein Fahrzeug (oder anderes Motiv) doppelt, auch nicht aus anderer Perspektive.

## Inhalte und Admin-Panel

- Alle Inhalte stehen in `content.json`: Texte (`site`), Fotos (`photos`: `f` = Dateiname ohne .jpg, `t` = Beschreibung, `c` = Kategorien auto/moto/outdoor/tiere, erste = Highlights-Kapitel, `ar` = Seitenverhältnis, `hl` = in den Highlights), Fotoordner (`folders`), Video-Edits (`videos`, Cover in `fotos/edits/`), Preise (`packages`) und `inbox` (Supabase-URL + publishable Key fürs Kontaktformular).
- `index.html` lädt `content.json` beim Start (`start(C)`). Fehlt die Datei, gelten `FALLBACK_PHOTOS` und die Texte im HTML. Bereiche „Edits“ und „Preise“ erscheinen nur, wenn es Einträge gibt.
- Matteo pflegt alles über `admin.html` (mapq.at/admin.html, noindex). Das Panel schreibt mit seinem GitHub-Token pro „Veröffentlichen“ einen Commit (`Admin: …`). Inhalte daher in `content.json` ändern, nicht im HTML – sonst überschreibt das Panel sie nicht, aber sie passen nicht mehr zusammen.
- Anfragen vom Formular landen in Supabase (Tabelle `anfragen`); das SQL dafür zeigt das Panel unter Einstellungen.
- Anmeldung im Panel nur mit Passwort: `admin-key.json` enthält GitHub-Token und Postfach-Zugang, verschlüsselt (AES-GCM, Schlüssel per PBKDF2-SHA256 aus dem Passwort). Datei nie löschen oder von Hand ändern – sonst kommt Matteo nicht mehr ins Panel.

## Design-System

Gültig für mapq.at: `design-system/mapq-raw/MASTER.md` (erstellt mit dem Skill ui-ux-pro-max).
Seitenspezifische Abweichungen liegen in `design-system/mapq-raw/pages/<seite>.md` und gehen MASTER.md vor.

`.claude/design-system.md` ist eine Fintech-Dashboard-Vorlage und gilt nicht für mapq.at.

## Versteckte Extras (nicht entfernen, Besuchern nicht verraten)

Im Skript-Block „Versteckte Extras“ in `index.html`. Alle respektieren „Bewegung reduzieren“.
- Konami-Code (↑ ↑ ↓ ↓ ← → ← → B A): RAW-Modus, alle Fotos schwarz-weiß mit Filmkorn, nochmal = aus.
- „brumm“ oder „vroom“ tippen: Motorsound.
- „drift“ tippen: Seite driftet kurz quer.
- 5x schnell aufs Logo: Motorsound und Burnout-Rauch.
- Sehr schnell scrollen: Blitzer (Blitz + „Geblitzt! … km/h“), höchstens alle 30 s, nicht bei Menü-Klicks.
- Doppelklick aufs große Foto in der Großansicht: Kamera-Auslöser mit Blitz.
- Tab im Hintergrund: Titel „Motor läuft noch …“.
- Besuch zwischen 0 und 4 Uhr: Hinweis „Nachtschicht?“ (einmal pro Sitzung).
- Browser-Konsole: Begrüßung mit Tipp zum Konami-Code.
Tippen in Formularfeldern löst nichts aus.
