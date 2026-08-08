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
- **`src/interaction/LayerStackWidget.ts`** — the top strip (`_drawCurrentLabel`,
  the existing "current layer name" bar, `TOP_MARGIN` tall) is a level-meter
  style **load bar**: plain `HOTSPOT_GREY` background, with a bar of colour
  `HOTSPOT_RGB` (the same red the card glow uses — see below — so the two
  signals read as visually related) growing from the strip's left edge as
  `_hotspotBarFraction()` rises above `0`. Unlike `_hotspotState()`'s
  rank-relative "load" (used only to pick which single card glows — see
  below), the bar is calibrated in **absolute per-frame ms**: it sums
  `evalCostMs` across every `_hotspotCandidates()` layer (total, not
  worst-single-layer — what actually costs frame rate is the sum of every
  dirty layer's recompute() that frame, whether concentrated in one layer
  or spread across several), and maps that sum linearly from `0` at
  `HOTSPOT_BAR_START_MS` (≈33ms, a 30fps floor — cost below this isn't yet
  a visible smoothness concern) to `1` at `HOTSPOT_BAR_JERKY_MS` (100ms, a
  10fps ceiling — "video looks very jerky around here," the calibration
  point requested directly). No animation — the bar's width is a pure
  function of the current EMA sum, never time.

  **Two revisions before landing here**, both from live testing rather than
  anticipated up front. v1 was a binary threshold (`HOTSPOT_SHARE = 0.45`,
  snap to a fixed dark red) — the on/off snap read as too subtle to notice
  reliably. v2 replaced it with a continuous grey→red *hue* gradient driven
  by the same rank-relative share `_hotspotState()` still uses for the card
  glow — better, but still "not doing well" in practice: a hue ramp is hard
  to read precisely, and rank-relative share doesn't actually answer the
  question a performer cares about (is this costing me frame rate?), since
  a stack of several moderately-expensive layers with no single dominant
  one could read as perfectly fine despite genuinely hurting FPS. v3
  (current) fixes both: a fixed-hue bar whose *length* encodes an absolute,
  FPS-anchored quantity is both more precise to read and answers the right
  question, and reusing the card glow's colour ties the "notice" and
  "locate" signals together visually. `HOTSPOT_RED` (the old muted hue-ramp
  colour) and `_hotspotColor()` were removed as dead code.
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
  fixed at `HOTSPOT_RGB = '255,50,50'` — shared with the strip's load bar
  above, by request, so the two signals read as visually related — and
  `load` drives only `shadowColor` opacity, on explicit feedback that
  varying colour to indicate intensity read less clearly here than varying
  brightness. (Before the strip's own v3 revision above, this comment used
  to describe the glow as deliberately *brighter* than the strip's colour;
  that's no longer the distinction — the strip switched to using this same
  bright `HOTSPOT_RGB` for its bar instead of a separate muted hue.)
  **Visibility gated on `_hotspotBarFrac > 0`, not `_hotspotLoad > 0`**: the
  glow only appears once the strip's bar has actually started rising, i.e.
  once total cost clears `HOTSPOT_BAR_START_MS`. Previously it lit up on
  any positive rank-relative share, which included cases with negligible
  absolute cost (e.g. two trivial layers on an otherwise-empty canvas,
  where one is merely *more* trivial than the other) — a "worst" layer that
  wasn't remotely close to hurting frame rate. Both `_hotspotBarFrac` and
  `_hotspotLoad`/`_hotspotLayer` are computed once per `render()` call and
  cached for the frame, so gating on one and driving intensity from the
  other costs nothing extra.

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

- **Background collection aggregate warning** — the shared hotspot math and
  the glow-drawing helper were pulled out of `LayerStackWidget.ts` into a
  new module, `src/interaction/hotspot.ts`
  (`HOTSPOT_RGB`/`HOTSPOT_GLOW_BLUR`/the FPS calibration constants,
  `sumEvalCost`, `hotspotBarFraction`, `hotspotWorst`, `drawHotspotGlow`),
  so `DeletionLayer` could reuse the exact same math and visual technique
  for the Background collection rather than reimplementing a parallel
  version. Three pieces:
  - **`Layer.backgroundCostMs`** (`src/core/Layer.ts`) — a new generic
    hook, default `0`, for a layer that maintains its own off-stack
    collection with an ongoing cost of its own. `DeletionLayer` overrides
    it to `sumEvalCost(this._background?.items ?? [])` — Background items
    keep recomputing every frame (self-perpetuating, see `CLAUDE.md`) even
    though nothing on-stack depends on them, so this is real, not
    hypothetical, cost. Deliberately scoped to the Background collection
    only, not `DeletionLayer`'s own archive (`_archived`, which also keeps
    evaluating) — the user asked specifically about layers moved to
    Background; the archive is a natural follow-up, not yet covered.
  - **Folded into the strip's own total** —
    `LayerStackWidget._hotspotBarFraction()` now sums
    `sumEvalCost(this._hotspotCandidates())` *plus*
    `l.backgroundCostMs` over every on-stack layer (only `DeletionLayer`
    ever reports non-zero) before converting to a fraction, so moving an
    expensive layer to Background to declutter the stack no longer makes
    the strip's own bar silently go quiet — the cost didn't go away, it
    just left the visible stack.
  - **Two glow sites** — `LayerStackWidget._drawCard`'s hotspot block
    gained a second, independent trigger alongside the existing on-stack
    one: `hotspotBarFraction(layer.backgroundCostMs)`, so `DeletionLayer`'s
    *own* stack card glows once the Background collection it browses is
    itself over the "video looks very jerky" threshold — a locate signal
    for "look inside here" before you've even opened it. Once opened (on
    the Background tab), `DeletionLayer._drawGrid` casts the same glow,
    with the same `radius = 6` as the card's own rounded corners, onto
    whichever specific item `hotspotWorst(items)` names as worst within the
    collection — computed once per `_drawGrid` call, gated on
    `this._showBackground` (no glow on the Deleted/archive tab) and on
    `hotspotBarFraction(this.backgroundCostMs) > 0` (same threshold as
    everywhere else). Cast before anything opaque covers that grid cell's
    footprint, same "shape → covered by the thumbnail → only the blur
    bleed survives" technique as the on-stack card glow.
  - Incidental fix while generalizing: `hotspotWorst` (formerly
    `_hotspotState`'s inline body) now treats a lone candidate as trivially
    "worst" at load `1` rather than refusing to name a worst layer at all
    below 2 candidates — needed for a Background collection that
    legitimately holds just one (expensive) item, and a strict improvement
    for the on-stack case too (a single real content layer that's making
    the whole app jerky previously got no card glow at all, for lack of a
    second layer to rank it against, even while the strip's bar read full).

- **`BindingMapLayer` source-vs-consumer glow** — this layer's diagram pill
  shows one source thumbnail and one thumbnail per bound consumer; the
  question "is the expensive one upstream (the source) or downstream (a
  specific consumer)?" is exactly `hotspotWorst` applied to
  `[source, ...consumers]`, computed once per `renderPanel` call and
  passed down to `_drawThumb` (now takes a `glow: number` parameter,
  casting via the shared `drawHotspotGlow` before the thumbnail's own
  opaque draw covers the footprint — same technique everywhere else).
  **No absolute-cost threshold gate here** (unlike the strip/Background
  glows, which require clearing `HOTSPOT_BAR_START_MS`): this diagram is
  opened deliberately to inspect one specific source's bindings, not
  glanced at ambiently during a performance, so any non-zero cost
  difference is worth surfacing immediately — `hotspotWorst` already stays
  quiet on its own when every node in the diagram costs exactly nothing.

  **Required generalizing `hotspot.ts` from `Layer` to `Node`**:
  `sumEvalCost`/`hotspotWorst` (and `hotspotWorst`'s returned field,
  renamed `layer` → `node`) now operate on `Node[]`, since `evalCostMs`
  lives on `Node` and `BindingMapLayer`'s source/consumer references
  (`ParameterSlot.owner`) are typed `Node`, not `Layer` — a consumer need
  not be a `Layer` at all. `LayerStackWidget._hotspotState()` (which only
  ever deals in `Layer`s, from `_hotspotCandidates()`) casts the result
  back at its one call site rather than threading `Node` through its own
  public-ish return type and every downstream field
  (`_hotspotLayer: Layer | null`) for no real benefit there.

- **`CollectionLayer` per-item glow** — same "locate which item inside is
  worst" question as `DeletionLayer`'s Background tab, applied to
  `CollectionLayer._drawGrid`'s own always-visible thumbnail grid (no tabs
  here — just the one `_layers` list). Gated the same way: only shows once
  `hotspotBarFraction(sumEvalCost(this._layers)) > 0`, then glows whichever
  item `hotspotWorst(this._layers)` names as worst, `radius = 4` to match
  the grid's own rounded cells. **No `backgroundCostMs`-equivalent hook was
  needed for `CollectionLayer`** — unlike `BackgroundLayer` (off-stack,
  invisible to `LayerStackWidget` entirely without one), `CollectionLayer`
  is an ordinary on-stack layer whose own `recompute()` calls
  `layer.evaluate()` on its ingested items *synchronously inside* the
  timed `Node.evaluate()` call, so its own `evalCostMs` already includes
  every ingested item's cost — its own stack card already glows correctly
  via the existing on-stack hotspot path with zero new plumbing. The only
  gap was the "locate the specific item" half, now filled the same way as
  Background.

Typecheck clean (no new errors beyond the pre-existing `TS2352` cast
baseline).

## Not yet implemented — natural next steps

1. **Click-to-jump** — clicking the warned top strip (or a glowing card)
   could select the offending layer directly, reusing the existing
   "click a bound slot to select its source" gesture convention. Now
   unblocked — the glow exists, so there's something on-screen to jump to
   that isn't already necessarily the selected layer.
2. **`DeletionLayer`'s own archive** — `_archived` layers also keep
   evaluating every frame (see `DeletionLayer.recompute()`) but aren't
   folded into `backgroundCostMs` or given their own per-item glow, since
   the user's request was scoped to the Background collection
   specifically. Same machinery (`hotspot.ts`) would apply directly.

## Open design questions for a future session

- Should the top strip's *text* switch to naming the hotspot layer when it
  differs from the selection, or stay purely as a "go look" beacon (current
  behaviour) until the card glow exists to do the naming/locating job?
- `HOTSPOT_BAR_START_FPS = 30` / `HOTSPOT_BAR_JERKY_FPS = 10` and the EMA
  `α = 0.2` are all unvalidated first guesses — worth tuning once there's a
  real heavy-layer scenario to test against (e.g. CPU-throttle one tab in
  devtools with a `FilterLayer`/`MotionBlurLayer` chain alongside cheap
  layers, since normal load tends to spread thinly across the stack and
  won't trigger the indicator otherwise). In particular, `evalCostMs` only
  measures `recompute()` self-time, not the canvas rendering cost each
  frame also pays — so the bar's ms→FPS calibration is an approximation
  that ignores render cost entirely; worth revisiting if the bar reads as
  systematically optimistic (empty/grey when the app is visibly janky) once
  there's a real scenario to compare it against.
