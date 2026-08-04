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
| 4 | `AnimationPathLayer.ts` | `_renderLabel`, was ~204–241 | `(px, py)` output coords, `t=0.42` | Removed — `renderPanel` override and `_renderLabel` deleted; no hit-testing was attached (`hitTestSelf` only tests control points), so nothing became unreachable. Header comment updated: rendering is now entirely `renderOverlay` |
| 7 | `DirectionLayer.ts` | `_drawPill`, was ~572–625 | `∠ angle°`, `m magnitude`, plus a 7-slot ●/○ dot-row summary | Removed — `renderPanel` override and `_drawPill` deleted. Angle/magnitude text was a literal duplicate of the readout already drawn under the dial in `_renderDial` (`renderOverlay`); the dot-row summary duplicated the full Bound/Suspended/Unbound rows already drawn by `renderSlots` (`positionSlot`/`handleSlot`/`lineSlot`/`magnitudeSlot`) and `_drawRotatePill` (`cwSlot`/`speedSlot`/`rotateToggleSlot`). Orphaned `POINT_ACCENT` const also removed |
| 12 | `PointLayer.ts` | label bar in `renderPanel`, was ~970–1003 | `(px, py)` current point | Removed — `renderPanel` (the whole method, which held only this label bar) deleted; `hitTestSelf` doesn't reference it. Header comment's rendering-components list updated (was 4 items, now 3) |
| 13 | `TransformLayer.ts` | `renderPanel`, was ~668–724 | `∠ angle° × scale (x, y)` combined readout, plus a 6-slot ●/○ dot summary (src/pos/sc/rot/ctr/op) | Removed — `renderPanel` (the whole method, which held only this pill) deleted. All six slots already get full binding rows via `renderSlots`; the angle/scale/position readout duplicated the draggable move/scale/rotate handles in `renderOverlay`. `hitTestSelf`'s `canvasBounds` click-swallow check (line ~377, unrelated to what's drawn there) left untouched — it still needs to claim that area so pixel-pick doesn't fire on panel background clicks |
| 11 | `TraceLayer.ts` | `_drawPill`, status text only | `"N pts"` / `"…"` / `"—"` status | Removed just the status-text block; the pill's background, accent stripe, and DETECT button (`_detectBtnBounds`) are unchanged, since DETECT is a real interactive control anchored to that pill, not redundant status |

---

## Kept (reviewed, not removed)

| # | Layer | Location | What it showed | Reason kept |
|---|---|---|---|---|
| 6 | `DeletionLayer.ts` | `_drawPill`, ~414–437 | `"Background (n)"` / `"Deleted (n)"` label | Reports which set (archive vs. background) is currently showing; not actually duplicated elsewhere. The always-visible canvas-space header (`_drawGrid`) only names the current set when the grid is empty; once non-empty it just says "Double-click to restore", and the toggle button is labeled with the *other* set. Note: `_drawPill` draws at `this.bounds` (the widget-column strip), which is clipped out by `Evaluator.render()` whenever the StackWidget is visible — so in the default state this status is actually only visible with `h` (hide widget). Left as-is per user decision (2026-08-04); revisit if the header hint is ever reworked to state the current set explicitly |
| 5 | `ClockLayer.ts` | `_drawPill`, ~151–192 | `⏱ N s` elapsed time | Not a standalone status pill like the others — one combined pill holds the elapsed-time text *and* the play/pause + reset buttons together (`⏱ 12.45 s  [▶/⏸] [↺]`). The elapsed-seconds readout isn't shown anywhere else, so it's not redundant either. Left as-is per user decision (2026-08-04) |
| 8 | `ColourLayer.ts` | `_drawPill`, hex readout | `#rrggbb` hex readout kept; slot-indicator dots removed | Split verdict (2026-08-04) — the hex label is genuinely useful (matching a colour value against other applications) and stays. The `P`/`H` position/hue ●/◐/○ slot-indicator dots (was lines ~365–390) were removed: redundant with the app-wide convention that a bound slot shows filled in its own binding row (`renderSlots` → `renderSlotGroup` already draws full Bound/SuspendedBound/Unbound rows for `hueSlot`/`posSlot`) |
| 10 | `TempoLayer.ts` | `_renderPhaseArc`, ~283– | BPM / metronome-marking / `φ 0.42` phase text, originally drawn inside the dial ring (obscured by the sweep stroke) | Relocated, then simplified (2026-08-04) — moved below the ring so it's legible; a `< 10 BPM` mode was added (metronome terms stop making musical sense that low), showing seconds-per-cycle instead. Follow-up feedback then trimmed the under-dial version to a single line with no background pill: just the metronome marking name (ordinary tempos) or `"N seconds per cycle"` (`< LOW_BPM_THRESHOLD`) — no bare BPM number and no phase (`φ`) readout under the dial. (A backdrop pill added mid-way to fix a light-text-on-light-content legibility bug was itself removed per the same feedback — visually too heavy.) The strip-pill copy next to the rate slider (`_drawPill`) is unchanged: still two lines, BPM+marking or seconds+"per cycle" |

---

## Skipped — dead code

| # | Layer | Location | What it shows | Reason skipped |
|---|---|---|---|---|
| 9 | `RotateLayer.ts` | `_drawPill`, ~191–219 | `"Rotate"` label, `∠ angle°` (also duplicated under the sweep-hand dial, ~245–250) | Not reachable through the running app — the menu button was removed (`MenuLayer.ts:213`, "functionality now provided by rotation of Angle") and nothing else constructs a fresh `RotateLayer`; only a legacy save file predating that removal could still load one via `Persistence.ts`'s `LAYER_CLASSES`. Left as-is per user decision (2026-08-04) — kept as dead code in case the layer is restored later, not worth touching its rendering in the meantime |

---

## Remaining candidates

None — all 13 surveyed items have been reviewed (see Done / Kept / Skipped above).

---

## Excluded (legitimate interactive controls, not redundant status)

`AmountLayer` slider value, `EventLayer`'s Hz/BPM next to its rate slider,
`FlashLayer`'s badge/duration text (tied to a draggable thumb), `TempoLayer`'s
BPM text *inside its own strip pill* (adjacent to its rate slider — the
separate phase-arc dial readout is covered under #10 above),
`FilterLayer`/`MathLayer` pills (fully interactive), `CountLayer`/`SequencerLayer`
(already touch-target-converted), `MenuLayer`'s pill (a button, not a readout),
`TraceLayer`'s DETECT button (covered under #11 above — only its status text
was removed).

Also skipped: `RootLayer`'s clock dial (intentional, tied to the `ClockLayer`
singleton binding — see CLAUDE.md), and `VideoLayer`/`TextLayer`/`MaskLayer`/
`CaptureLayer` status strips already removed in the mobile touch-target pass.
