# Design System

Product type: SaaS analytics dashboard
Industry: B2B fintech
Generated: 2026-01-15

## Pattern
Dense data layout — sticky sidebar, 12-column grid, sticky table headers.
Reference: landing/data-dashboard-sticky-sidebar

## Style
Minimalism with subtle glass accents on hover cards.
Why: fintech anti-pattern bans high-saturation hero gradients;
minimalism + restrained glass keeps it credible.

## Colors
Primary:   #2563EB  (blue-600)
Surface:   #FFFFFF / #0B1220
Text:      #0F172A / #E2E8F0
Accent:    #10B981  (emerald, use sparingly for KPI deltas)
WCAG AA pairings checked.

## Typography
Display: Inter 700 / 48-56 px
Body:    Inter 400 / 15-16 px / 1.55 line-height
Numeric: IBM Plex Mono for tabular figures

## Effects
Shadow scale: 0/1/2/4 only. Avoid deep shadows.
Motion:      150-200ms ease-out. Honor prefers-reduced-motion.

## Anti-patterns to avoid
- Don't use red as a brand color (signals loss)
- Don't auto-rotate carousels on the dashboard
- Don't hide bulk actions behind hover-only UI

## Pre-delivery checklist
- [ ] All chart colors are colorblind-safe
- [ ] Tabular numbers use mono font
- [ ] Empty states have illustrations and CTA
- [ ] Loading states show skeletons, not spinners-only
