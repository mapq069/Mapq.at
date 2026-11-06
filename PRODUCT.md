# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hauptsächlich Freunde und Follower von Matteo, die über Instagram (@mapq.raw) kommen (von Matteo bestätigt). Sie kennen ihn oder seine Fotos schon und schauen meist am Handy vorbei.

## Product Purpose

mapq.at ist die Seite von Matteo Hanser (mapq.raw), Fotograf in Tirol: Autos, Motorräder, Motorsport-Events und Outdoor. Erfolg heißt: Besucher fragen ein Shooting an (von Matteo als Hauptziel bestätigt) – über das Formular, das im Admin-Postfach landet, oder per Instagram.

Dezi (mapq.at/dezi) ist ein Bass-Contest für Freunde und die Szene: Wer hat mehr Bass im Auto? Spaß steht vorne, kein ernster Wettbewerb (von Matteo bestätigt). Man misst mit dem Handy, reicht mit Foto ein und landet in der Rangliste.

## Positioning

Ein junger Fotograf aus Tirol, der selbst in der Auto- und Motorradszene unterwegs ist: echte eigene Fotos von Fahrzeugen aus der Gegend, persönlich und nahbar statt Agentur. Dezi zeigt, dass mapq.raw Teil der Szene ist und nicht nur fotografiert.

## Operating Context

- Instagram ist der Hauptkanal; Besucher kommen über die Bio oder Stories.
- Event-Fotos liegen in Google-Drive-Ordnern, die die Seite verlinkt (Button „Ordner“).
- Matteo pflegt Texte, Fotos, Ordner, Edits und Preise selbst im Admin-Panel (`admin.html`), das `content.json` per GitHub-Commit veröffentlicht.
- Anfragen und Dezi-Einreichungen gehen in Supabase (Tabelle `anfragen`) mit Push aufs Handy.

## Capabilities and Constraints

- Statische Seiten auf GitHub Pages, kein Build-Schritt, eine HTML-Datei pro Seite.
- `index.html` liest alle Inhalte aus `content.json` (`start(C)`); IDs und Klassen, die das Skript befüllt, müssen erhalten bleiben. Bereiche „Edits“ und „Preise“ erscheinen nur mit Einträgen.
- Hauptseite: Highlights-Strecke, Bilder mit Filtern und Großansicht, Über mich, Kontaktformular, Ordner-Dialog, Impressum, versteckte Extras (siehe `.claude/CLAUDE.md`), Dezi-Karte.
- Dezi: Dezibel-Messer übers Mikrofon (nur https), 3-Sek-Burp, Rangliste (Supabase + `rangliste.json`), Einreichen mit Fotos, Schnell-Formular nach dem Burp.
- Jedes Motiv nur einmal: kein Fahrzeug doppelt, auch nicht aus anderer Perspektive.
- Alles muss am Handy funktionieren; „Bewegung reduzieren“ wird respektiert.

## Brand Commitments

- Name „mapq.raw“, Matteo Hanser, Tirol.
- Nur eigene Fotos von Matteo.
- Dezi soll bunt und auffällig sein (Matteos ausdrücklicher Wunsch).
- Sprache: Deutsch, per Du, kurz und locker.

## Evidence on Hand

- 11 eigene Fotos in `fotos/` (Autos, Supermoto, Outdoor, Hund), gepflegt in `content.json`.
- 4 Google-Drive-Ordner von Events (Oldtimertreffen Buch und Aschach, Autoslalom Stans und Jais Hall, September 2026).
- 1 Video-Edit, noch keine Preise.
- Keine Kundenstimmen, keine Kundenlogos, keine Zahlen zu Aufträgen – nichts davon erfinden.
- Dezi-Rangliste ist noch leer.

## Product Principles

1. Die Fotos sind das Argument: sie zuerst, alles andere tritt zurück.
2. Anfragen muss leicht sein – von überall auf der Seite ein kurzer Weg.
3. Persönlich statt Agentur: Matteo spricht selbst, per Du.
4. Matteo muss alles selbst im Panel pflegen können, ohne Code.
5. Dezi ist Spaß: schnell messen, Ergebnis feiern, teilen.
