# Status/readout pill removal — review candidates

Many layers draw a narrow, read-only "status" pill above the value-binding
controls (e.g. shape dimensions, rotation angle, current coordinates) that
restates information the user is already controlling elsewhere and doesn't
help operate the layer. This document tracks the survey (2026-08-03) and the
layer-by-layer review of whether each one is safe to remove.

Reviewed one at a time; see "Done" for items already actioned.

---

## Done

| # | Layer | Location | What it showed | Verdict |
|---|---|---|---|---|
| 1 | `ShapeLayer.ts` (Rect/Ellipse) | `_drawPill`, was ~1167–1219 | `width × height`, `∠ angle°` | Removed — `renderPanel` override and `_drawPill` deleted, `DIR_ACCENT` const cleaned up |
| 2 | `PathLayer.ts` | `_drawPill`, was ~770–812 | `"N pts"`, `∠ angle°` | Removed — same treatment as #1 |
| 3 | `AnimPathLayer.ts` | `_drawPill`, was ~537–572 | `"AnimPath"` label, CW/CCW icon, `(x, y)` current point | Removed — `renderPanel` override and `_drawPill` deleted (real CW/CCW toggle lives in `renderSlots`, untouched) |

---

## Remaining candidates

| # | Layer | Location | What it shows | Type |
|---|---|---|---|---|
| 4 | `AnimationPathLayer.ts` | `_renderLabel`, ~204–241 | `(px, py)` output coords, `t=0.42` | Standalone pure-status pill |
| 5 | `ClockLayer.ts` | `_drawPill`, ~151–192 | `⏱ N s` elapsed time | Readout inside otherwise-interactive pill (play/pause + reset live here too) |
| 6 | `DeletionLayer.ts` | `_drawPill`, ~414–437 | `"Background (n)"` / `"Deleted (n)"` label | Standalone pure-status pill (duplicates a real toggle button elsewhere) |
| 7 | `DirectionLayer.ts` | `_drawPill`, ~572–630 | `∠ angle°`, `m magnitude` | Standalone pure-status pill (also duplicated a second time under the dial in `renderOverlay`, ~735–743) |
| 8 | `ColourLayer.ts` | `_drawPill`, ~313–393 | `#rrggbb` hex readout | Redundant text restating the SV/hue picker's current value |
| 9 | `RotateLayer.ts` | `_drawPill`, ~191–219 | `"Rotate"` label, `∠ angle°` | Standalone pure-status pill (angle also duplicated under the sweep-hand dial, ~245–250) |
| 10 | `TempoLayer.ts` | `_renderPhaseArc`, ~232–279 | Duplicate BPM/tempo text + `φ 0.42` phase readout | Standalone, no hit-test at all |
| 11 | `TraceLayer.ts` | `_drawPill`, ~510–553 | `"N pts"` / `"…"` / `"—"` status | Readout sharing a pill with the interactive DETECT button |
| 12 | `PointLayer.ts` | label bar in `renderPanel`, ~970–1001 | `(px, py)` current point | Standalone pure-status pill |
| 13 | `TransformLayer.ts` | panel block, ~668–724 | `∠ angle° × scale (x, y)` combined | Standalone pure-status pill (real handles are separate draggable circles in `renderOverlay`) |

---

## Excluded (legitimate interactive controls, not redundant status)

`AmountLayer` slider value, `EventLayer`'s Hz/BPM next to its rate slider,
`FlashLayer`'s badge/duration text (tied to a draggable thumb), `TempoLayer`'s
BPM text *inside its own strip pill* (adjacent to its rate slider — only the
separate phase-arc readout in #10 above is flagged), `FilterLayer`/`MathLayer`
pills (fully interactive), `CountLayer`/`SequencerLayer` (already
touch-target-converted), `MenuLayer`'s pill (a button, not a readout).

Also skipped: `RootLayer`'s clock dial (intentional, tied to the `ClockLayer`
singleton binding — see CLAUDE.md), and `VideoLayer`/`TextLayer`/`MaskLayer`/
`CaptureLayer` status strips already removed in the mobile touch-target pass.
