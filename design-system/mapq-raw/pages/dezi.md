# Dezi Page Overrides

> **PROJECT:** mapq.raw
> **Generated:** 2026-11-05 14:44:56
> **Page Type:** General

> ⚠️ **IMPORTANT:** Rules in this file **override** the Master file (`design-system/MASTER.md`).
> Only deviations from the Master are documented here. For all other rules, refer to the Master.

---

## Page-Specific Rules

### Layout Overrides

- **Max Width:** 1200px (standard)
- **Layout:** Full-width sections, centered content

### Spacing Overrides

- No overrides — use Master spacing

### Typography Overrides

- No overrides — use Master typography

### Color Overrides

Matteo wollte Dezi auffälliger als die Hauptseite: Neon wie Car-Audio-Beleuchtung statt Schwarz-Weiß.

| Rolle | Wert |
|-------|------|
| Hintergrund | `#05030A` mit Farbschleiern (Magenta oben rechts, Cyan links, Violett unten) |
| Karten | `#0D0A16`, Rahmen `#2E2742` |
| Neon Cyan | `#00E5FF` |
| Neon Violett | `#7C4DFF` |
| Neon Magenta | `#FF2BD6` |
| Neon Rot | `#FF3B3B` (Ende der Skala) |
| Verlauf | Cyan → Magenta (Buttons), Cyan → Violett → Magenta → Rot (Rahmen, Überschriften, Pegel) |
| Text auf Neon | `#06020D` (dunkel, gut lesbar) |
| Gefahr | `#EF4444` bleibt nur für Gehör-Warnung und Übersteuerung |
| Podest | Gold `#FFB800`, Silber `#9CA3AF`, Bronze `#B4622B` |

### Component Overrides

- Primär-Button: Verlauf Cyan → Magenta, dunkle Schrift, Magenta-Leuchten statt Schatten.
- Sekundär-Button: transparent, 2px Cyan-Rahmen, Leuchten beim Hover.
- Karten (Messgerät, Formular, Ergebnis, Dialog): 2px Verlaufsrahmen; das Messgerät leuchtet stärker, je lauter es ist (`--lvl`).
- Überschriften `.display` mit Klasse `neon`: Verlaufsschrift mit Leuchten.

---

## Page-Specific Components

- Subwoofer im Hero (pulsiert im Takt, 128 BPM) mit Schallwellen und Equalizer-Balken.
- Schräges Laufband im Verlauf unter dem Hero.
- Tacho mit Verlaufsbogen, LED-Pegelkette (30 Segmente, Spitze weiß), Live-Punkt, leichtes Wackeln ab 105 dB.
- Countdown mit Puls, Stroboskop während der Messung, Konfetti beim Ergebnis.

---

## Recommendations

- Effekte: kräftiges Neon-Leuchten erlaubt, Text bleibt aber hell auf dunkel und gut lesbar; alle Animationen aus bei „Bewegung reduzieren“.
