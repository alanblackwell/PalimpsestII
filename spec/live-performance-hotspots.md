# Live-performance hotspot indicator

Goal: give a performer using Palimpsest in an improvised stage-performance
context a very low-cost, glanceable way to notice when a layer (or a chain
of bindings feeding it) is dominating per-frame recompute cost, without
requiring them to stop and read numbers.

## Design constraints established in discussion (2026-08-07)

- **Rank-relative, not absolute-ms.** A performer under time pressure only
  has bandwidth to react to "what's the worst thing right now" — not a
  number that needs per-device frame-budget calibration.
- **No animation/pulsing.** Palimpsest follows the live-coding convention
  that the audience sees the same screen as the performer, so signals must
  be static retints rather than motion that would read as content or
  distract from it.
- **Two-stage design**: a fixed-position "notice" signal (always in the same
  place, cheap to check) separate from an in-place "locate" signal (found by
  scanning the stack once you know something's wrong). This session
  implemented stage 1 only.

## Implemented (this session)

- **`src/core/Node.ts`** — `Node.evaluate()` now times each node's own
  `recompute()` call (`performance.now()` before/after) and folds it into
  an EMA (`_evalCostEma`, α = 0.2), exposed via `get evalCostMs()`. This is
  genuinely *self* time, not inclusive of dependency cost — dependencies are
  evaluated in the loop above, before the dirty check, so their own timing
  already happened in their own `evaluate()` calls by the time this node's
  `recompute()` runs. The EMA holds its last value between recomputes rather
  than decaying (a node that stopped being dirty didn't get cheaper, it just
  stopped running).
- **`src/interaction/LayerStackWidget.ts`** — `_hotspotLayer()` finds the
  on-stack layer (from `this._layers` — the same non-infrastructure,
  non-hidden-helper set the widget already tracks) whose `evalCostMs` share
  of the stack's total exceeds `HOTSPOT_SHARE` (0.45). When one clears that
  bar, `_drawCurrentLabel` retints the top strip (the existing "current
  layer name" bar, `TOP_MARGIN` tall) from its usual
  `rgba(0,0,0,0.72)` to a static dark red `HOTSPOT_BG =
  'rgba(96,24,24,0.82)'` — chosen to be visually distinct from all 11
  `ValueType` accent colours (which occupy most of the hue wheel already)
  by being dark/desaturated rather than a new hue. No animation, no text
  change — the strip still names the *selected* layer, not necessarily the
  hotspot; this was a deliberate choice (see "Open design questions" below).

Typecheck clean (no new errors beyond the pre-existing `TS2352` cast
baseline).

## Not yet implemented — natural next steps

1. **Card glow** — a static highlight (border/shadow tint, not fill, not
   animated) on the actual offending layer's thumbnail card in the stack
   widget, so that once the top-strip warning is noticed, scanning the
   stack finds the culprit. This is the "locate" half of the two-stage
   design; the top strip only tells you *that* something's wrong.
2. **Click-to-jump** — clicking the warned top strip (or the glowing card)
   could select the offending layer directly, reusing the existing
   "click a bound slot to select its source" gesture convention. Deferred
   until the glow exists, since right now there's nothing on-screen to
   jump *to* that isn't already the selected layer.
3. **Background/DeletionLayer aggregate warning** — `BackgroundLayer` items
   and `DeletionLayer`'s archive keep recomputing (self-perpetuating, see
   `CLAUDE.md`) but are invisible in the normal stack view — this is the one
   case where cost is currently *undiscoverable* in the UI at all, more so
   than an on-stack hotspot (which is at least locatable by elimination).
   The original proposal was to retint the Background/Deletion toggle pill
   when their aggregate cost is high. Not started — needs its own
   worst/total calculation over `backgroundLayer.items` and the archive,
   parallel to `_hotspotLayer()` but a separate candidate set.

## Open design questions for a future session

- Should the top strip's *text* switch to naming the hotspot layer when it
  differs from the selection, or stay purely as a "go look" beacon (current
  behaviour) until the card glow exists to do the naming/locating job?
- `HOTSPOT_SHARE = 0.45` and the EMA `α = 0.2` are both unvalidated first
  guesses — worth tuning once there's a real heavy-layer scenario to test
  against (e.g. CPU-throttle one tab in devtools with a `FilterLayer`/
  `MotionBlurLayer` chain alongside cheap layers, since normal load tends to
  spread thinly across the stack and won't trigger the indicator otherwise).
