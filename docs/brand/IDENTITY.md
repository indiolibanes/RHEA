# RHEA visual identity

This is the reference for anything that carries the RHEA name: the project page, the workspace app, the
README and the Android prototype. The code lives in `apps/web/src/rhea/` (`lamps.*`, `tones.*`,
`kinetic.*`); the exported marks live next to this file.

## Idea

Rhea is not drawn, she is lit. Her face is a disc of small lamps; a few brighten into two eyes and a
smile. The brand is calm light on deep green: gold for what is lit, earth brown for what holds it, ivory
for the page it is read on. Motion is light too: things gather, flicker and settle.

## Tones

Three tones share the same semantic roles. Forest is the default.

| Role | Forest | Earth | Ivory |
| --- | --- | --- | --- |
| Background | `#0e2a21` | `#2a1b11` | `#faf7f0` |
| Raised surface | `#163b2e` | `#3a2617` | `#ece2c8` |
| Text on background | `#faf7f0` | `#faf7f0` | `#0e2a21` |
| Muted text | `rgba(241,232,210,.8)` | `rgba(241,232,210,.8)` | `#3f4d45` |
| Accent | `#e9c75b` | `#e9c75b` | `#7a5b12` |
| Paper (light sections) | `#f1e8d2` | `#f3eadb` | `#f1e8d2` |
| Paper heading | `#0e2a21` | `#3a2617` | `#0e2a21` |
| Eyebrow / band | `#6a4329` | `#1f4a3a` | `#6a4329` |
| Footer | `#4a2e1c` | `#1c120b` | `#e6d9ba` |

Lamp face: disc `#0b231b`, unlit `#2d5a47`, lit `#ffe08a`, core `#fffaf0`, ring `#c9a13e`
(Earth: disc `#1f130b`, unlit `#6a4329`, lit `#ffc46b`; Ivory: disc `#12302a`).

Neon, used only by the kinetic layer: gold `#ffe08a` on deep surfaces, emerald `#0c8f62` on paper and in
Ivory. The workspace app keeps its own semantic tokens (`tones.css`); use the same hex values.

## Type

- Headings: EB Garamond 400, never synthetic bold. h1 `clamp(2.5rem, 6vw, 4.75rem)` / 1.04; h2
  `clamp(2rem, 4vw, 3rem)` / 1.1; h3 `1.55rem` / 1.18.
- Body: Atkinson Hyperlegible, `1.0625rem` / 1.7, measure 56 to 64 characters.
- Labels, nav, buttons, metadata: IBM Plex Mono, `0.78rem`, `0.14em` tracking, uppercase. One label size
  everywhere.
- Floor for any text: `0.75rem`.

## Face

`lamps.mjs` owns the geometry (hex grid, `DISC`, `lightAt`) and draws a static SVG for the HTML and a canvas
on top once scripts run. Behaviours: blink, gaze that follows the pointer (or wanders on touch), smile that
widens on hover, a ripple where it is touched, three antenna lamps above the gate in the ring. At 30 fps at
most, paused off screen, still under reduced motion.

## Motion vocabulary

`kinetic.mjs` and `kinetic.css` implement it. Everything is gated on `html[data-motion='on']`, which an inline
script sets before paint from `localStorage` (`rhea.motion`) or `prefers-reduced-motion`. A visible Motion
switch must always be offered.

Letters (`data-kx`):

| Effect | What it does |
| --- | --- |
| `flip` | Upside down and mirrored, then turns to the right way round with a small overshoot |
| `run` | Sprints in from either side, passes its place, returns |
| `melt` | Rises out of a puddle; leaves by dripping |
| `swap` | Tries mono, sans, italic serif, then settles (letter boxes are pinned so lines do not jitter) |
| `atoms` | Scatters, drifts into word-sized clusters, bonds with a short gold bar, settles |
| `neon` | An unlit tube catches, flickers and steadies with a faint glow |
| `auto` | Picks one at random on every play |

Titles also dissolve and re-form on their own every 5 to 9 seconds (one at a time, only when fully visible,
never while hovered, focused or selected). Blocks (`data-kx-reveal`) appear with a random rise, slide, zoom
or tilt and disappear again when they leave the screen.

Other pieces: a flowchart whose nodes take the colour of a travelling signal, a rim of light that circles
the primary button, a soft neon edge on secondary buttons, buttons that lean toward a mouse, a pulsing gold
diamond.

Rules: animate only `transform`, `opacity`, `background-position` (plus the discrete font swap); pause
anything off screen; keep the real text for assistive technology (each lettered title carries a
visually hidden copy and the letters are `aria-hidden`); pass values to CSS with `style.setProperty` so strict
CSP keeps working; nothing may hide content when JavaScript or motion is off.

## Marks

`rhea-mark.svg` (face and ring), `rhea-icon.svg` (face on a rounded square), `rhea-wordmark.svg` (outlined
letters, no font needed), `rhea-banner.svg` (README). The `-animated` variants add blink and antenna.
