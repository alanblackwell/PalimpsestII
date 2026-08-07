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
- **`src/interaction/LayerStackWidget.ts`** — `_hotspotLoad()` computes a
  continuous `[0, 1]` load value from `this._layers` (the same
  non-infrastructure, non-hidden-helper set the widget already tracks):
  the worst on-stack layer's `evalCostMs` share of the stack's total,
  rescaled so an even split across all layers (the floor share can't drop
  below) maps to `0` and one layer owning the entire stack's cost maps to
  `1`. `_hotspotColor(load)` linearly interpolates the strip's background
  from `HOTSPOT_GREY {110,110,110,0.72}` at load 0 to `HOTSPOT_RED
  {150,30,30,0.82}` at load 1, and `_drawCurrentLabel` fills the top strip
  (the existing "current layer name" bar, `TOP_MARGIN` tall) with that
  colour every frame. **Revised from the original binary threshold**
  (`HOTSPOT_SHARE = 0.45`, snap to a fixed dark red) after first live
  testing found the on/off snap read as too subtle to notice reliably —
  a continuous grey→red gradient gives a graded read of "how bad, right
  now" instead of a single trigger point, while keeping the no-animation
  constraint (colour is still a pure function of the current EMA values,
  never time — no pulsing).
- **`Layer.hotspotExempt`** (`src/core/Layer.ts`, overridden `true` on
  `RootLayer`, `MenuLayer`, `DeletionLayer`) — fixes a false-positive where
  the strip read red almost immediately on live testing. `RootLayer` and
  `MenuLayer` are permanent stack members with structurally near-zero
  `recompute()` cost (`MenuLayer.recompute()` is a literal no-op); with
  only those two plus one real content layer in `this._layers`, that one
  layer's actual canvas-drawing cost swamped a denominator that was mostly
  near-zero padding, so `_hotspotLoad()` read close to `1` as soon as any
  content existed at all — a measurement artifact of comparing real work
  against structural chrome, not a genuine imbalance between comparable
  layers. `DeletionLayer` is exempted too, for a different reason: its
  recompute cost (looping its archive) belongs to the not-yet-built
  Background/DeletionLayer aggregate warning (see item 3 below), not the
  on-stack per-layer ratio — counting it here would prejudge that separate
  signal. `LayerStackWidget._hotspotCandidates()` filters `this._layers` by
  this flag before the worst/total scan. No text change — the strip still
  names the *selected* layer, not necessarily the hotspot; this was a
  deliberate choice (see "Open design questions" below).
- **Card glow** (the "locate" half of the two-stage design) — `_drawCard`
  casts a static halo for whichever card `_hotspotState()` currently names
  as worst, once `load > 0`. `layer`/`load` are computed once per
  `render()` call via `_hotspotState()` (a single O(n) scan) and cached in
  `_hotspotLayer`/`_hotspotLoad` fields for the frame. The glow uses the
  *same technique* as the card's own drop shadow immediately above it in
  the code: `fillRect(0, 0, w, h)` with `shadowColor`/`shadowBlur` set and
  `shadowOffset` zero, then `ctx.restore()` before the thumbnail is drawn —
  the filled shape itself is invisible (fully covered by the thumbnail
  drawn right after), so only the shadow's outward gaussian bleed shows.
  This gives a true soft falloff with no crisp ring, and an inner edge
  flush with the card, "as with the shadow." It's drawn *after* the drop
  shadow so it composites on top of it, and — because it's cast from the
  card's own bounds as an ordinary part of `_drawCard`, not a final overlay
  pass — whichever card is stacked above this one in the same `render()`
  loop naturally paints over the glow's outward bleed for the region it
  occupies, exactly as it already does for the drop shadow. Colour is
  fixed (`HOTSPOT_GLOW_RGB = '255,50,50'`, brighter/more saturated than the
  top strip's deliberately-muted `HOTSPOT_RED` — the strip has to stay
  dark/desaturated to avoid reading as a 12th `ValueType` accent, but a
  soft halo around a card can afford to be punchier); `load` drives only
  `shadowColor` opacity, on explicit feedback that varying colour to
  indicate intensity read less clearly here than varying brightness.

  **Revised twice from the first version**, each round found by live
  testing rather than anticipated up front. v1 drew the glow as a
  `strokeRect` at the card's exact edge with a modest blur — invisible in
  practice, because this stack is an overlapping card fan (`_hitTest`'s own
  comment documents the same rule: "each card's upper portion is covered
  by the card above it in z-order"), so only the current and topmost cards
  ever show their full body; every other card exposes just a bottom sliver
  `sp` px tall (`_spacing()`, floored at `MIN_SPACING = 22`), and an
  in-place glow was overpainted along with the rest of the card — the
  near-universal case. v2 moved the glow to a final overlay pass drawn
  after every card so it would always be fully visible regardless of stack
  depth — which fixed visibility but traded away the occlusion behaviour:
  the glow then ignored the stack's own z-order entirely, appearing to
  float on top of cards that should have covered it. v3 (current) keeps
  v2's brighter colour and opacity-only intensity but reverts to drawing
  in-place, using the shadow-cast technique above instead of a stroke —
  which gets the gaussian falloff and correct occlusion "for free" from the
  same mechanism the card's own drop shadow already uses, rather than
  fighting the stack's draw order.

Typecheck clean (no new errors beyond the pre-existing `TS2352` cast
baseline).

## Not yet implemented — natural next steps

1. **Click-to-jump** — clicking the warned top strip (or the glowing card)
   could select the offending layer directly, reusing the existing
   "click a bound slot to select its source" gesture convention. Now
   unblocked — the glow exists, so there's something on-screen to jump to
   that isn't already necessarily the selected layer.
2. **Background/DeletionLayer aggregate warning** — `BackgroundLayer` items
   and `DeletionLayer`'s archive keep recomputing (self-perpetuating, see
   `CLAUDE.md`) but are invisible in the normal stack view — this is the one
   case where cost is currently *undiscoverable* in the UI at all, more so
   than an on-stack hotspot (which is at least locatable by elimination).
   The original proposal was to retint the Background/Deletion toggle pill
   when their aggregate cost is high. Not started — needs its own
   worst/total calculation over `backgroundLayer.items` and the archive,
   parallel to `_hotspotState()` but a separate candidate set.

## Open design questions for a future session

- Should the top strip's *text* switch to naming the hotspot layer when it
  differs from the selection, or stay purely as a "go look" beacon (current
  behaviour) until the card glow exists to do the naming/locating job?
- `HOTSPOT_GREY`/`HOTSPOT_RED` (the gradient endpoints) and the EMA `α = 0.2`
  are all unvalidated first guesses — worth tuning once there's a real
  heavy-layer scenario to test against (e.g. CPU-throttle one tab in
  devtools with a `FilterLayer`/`MotionBlurLayer` chain alongside cheap
  layers, since normal load tends to
  spread thinly across the stack and won't trigger the indicator otherwise).
