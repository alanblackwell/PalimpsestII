import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type Point,  type PointSource,
  type Amount, type AmountSource,
  type Direction,
  type RateSource,
  type EventSource,
  type MaskSource, type MaskValue,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { DraggablePointRegion, registerPromotionFactory } from '../regions/DraggablePointRegion.js'

registerPromotionFactory((initial: Point) => new PointLayer(initial))

// ------------------------------------------------------------
// PointLayer — a layer that holds and exposes a Point value
// ------------------------------------------------------------
//
// Two operating modes for the handle:
//
//   Unbound — the handle is freely draggable anywhere on the canvas
//             (or driven by wander mode, below).
//
//   Bound   — the handle is driven by a source layer (the slot);
//             the handle position is read-only.
//
// Rendering has these components:
//
//   1. A compact label bar at canvasBounds (canvas-space panel),
//      showing the current (x, y) coordinates.
//
//   2. A single-row pill directly below it for the main Point
//      binding (`slot`) — lets another Point source drive this
//      layer's output, e.g. as a named relay/tap point.
//
//   3. The wander pill (below that) — see below.
//
//   4. The draggable handle (crosshair circle) drawn at the point
//      value itself — which can be anywhere on the canvas.
//
// ------------------------------------------------------------
// Wander mode
// ------------------------------------------------------------
//
// A single consolidated pill, directly below the Point-binding row,
// drives the point with a small per-frame simulation when the main
// Point slot is unbound:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌ wander ────────────────────────────────────  ○    [⏸]  │  <- row 1
//   │   mode   [◀] drift [▶]                                    │  <- row 2
//   │   amount ──────●─────────────────────────────────  0.40  │  <- row 3
//   │   amount ──────────────────────────────────  unbound     │  <- row 4
//   │   speed  ───●────────────────────────────────────  0.30  │  <- row 5
//   │   speed  ──────────────────────────────────  unbound     │  <- row 6
//   │   mask   ──────────────────────────────────  unbound     │  <- row 7
//   └──────────────────────────────────────────────────────────┘
//
// - Row 1 — `wanderToggleSlot` (Event) binding row, with the [⏺]/[⏸]
//   on/off button at the right edge. Operating it manually hands permanent
//   control to the user: Bound -> suspend the binding and flip
//   `_wanderEnabled`; SuspendedBound or Unbound -> just flip
//   `_wanderEnabled`. (Unlike VideoLayer/ShapeLayer's toggle convention,
//   this button never resumes a suspended binding — re-enabling it is the
//   binding inspector's job.)
// - Row 2 — [◀] <algorithm> [▶] cycles through WANDER_TYPES
//   (drift / brownian / orbit / wave / track).
// - Row 3 — amount slider, showing the resolved value (manual or bound,
//   tinted to match row 4's binding state). Touching the slider suspends
//   a bound `amountSlot` (suspend-on-touch).
// - Row 4 — `amountSlot` (Amount) binding — a standard parameter-slot
//   drop target, directly beneath its slider.
// - Row 5 — speed slider, same "slider above its binding" treatment.
//   Manual slider [0,1] maps to [MIN_SPEED_PX, MAX_SPEED_PX] px/s; a bound
//   Rate is read directly (Hz) and scaled by SPEED_RATE_SCALE.
// - Row 6 — `speedSlot` (Rate) binding, directly beneath the speed slider.
// - Row 7 — `maskSlot` (Mask) binding row. When bound, the wandering
//   point is constrained inside the mask (sampled via alpha),
//   bouncing off the local edge normal (estimated from the alpha
//   gradient). When unbound, it bounces off the canvas edges instead.
//
// Simulation: each recompute() while wandering, _wanderTick() advances the
// point by `speed * dt` along `_heading`, perturbing `_heading` according to
// the selected algorithm, then reflects velocity off the mask/canvas
// boundary if the step would leave the permitted area. Self-perpetuates via
// queueMicrotask(() => forceDirty()) — same pattern as VideoLayer's frame
// loop — so it keeps animating every frame while enabled and in the stack.
//
// If the point is outside a bound mask at the start of a tick (the mask was
// just bound, or has moved/resized since the last tick), it is relocated to
// the nearest interior point before the step above: _nearestInsideMask
// tries a small local search first, falling back to a coarse whole-canvas
// search if the mask isn't found nearby.
//
// 'track' mode (_trackTick) bypasses the heading/velocity model above
// entirely: the point exponentially eases toward Node.pointerCanvas (the
// live mouse position, maintained by InteractionSystem), at a follow rate
// between TRACK_MIN_FOLLOW_HZ (speed=0, a visible trailing lag) and
// TRACK_MAX_FOLLOW_HZ (speed=1, effectively snaps within a frame). The
// `amount` slider sets the radius of a slowly random-walking drift offset
// applied to the tracked target — 0 follows the mouse exactly. If a mask is
// bound and the mouse is outside it, the target becomes the last point along
// the line from the point's current (in-mask) position to the mouse that is
// still inside the mask (_lastInsidePointAlongLine); the drift offset is
// clipped the same way, so it can pull the target back deeper into the mask
// but never push it outside.

const ACCENT      = '#cf7ecf'   // Point type accent
const EV_ACCENT   = '#e0e060'   // Event type accent (wander toggle)
const AM_ACCENT   = '#4a8fe8'   // Amount type accent (amount slot)
const RATE_ACCENT = '#e87e7e'   // Rate type accent (speed slot)
const MASK_ACCENT = '#cfcf7e'   // Mask type accent (mask slot)

// Per-type value-box colour for the slot rows drawn by this layer's
// renderSlots, matching the type accent colours used throughout the app.
const TYPE_COLOUR: Partial<Record<ValueType, string>> = {
  [ValueType.Point]:  ACCENT,
  [ValueType.Event]:  EV_ACCENT,
  [ValueType.Amount]: AM_ACCENT,
  [ValueType.Rate]:   RATE_ACCENT,
  [ValueType.Mask]:   MASK_ACCENT,
}

type WanderId = 'drift' | 'brownian' | 'orbit' | 'wave' | 'track'
const WANDER_TYPES: WanderId[] = ['drift', 'brownian', 'orbit', 'wave', 'track']

type BBox = { x: number; y: number; width: number; height: number }

// Panel layout
const PILL_PAD       = 4    // inner padding of each pill
const ROW_H          = 26   // height of every row (slot rows, slider rows, mode row)
const ROW_GAP        = 4    // vertical gap between rows
const LABEL_W        = 78   // label column width, matches Layer.renderSlots' value-box offset
const BTN_W          = 18   // mode-cycler / toggle button width
const BTN_H          = ROW_H - 6   // 20 — leaves a 3px margin top/bottom within a row
const MODE_LABEL_W   = 56
const SLIDER_VALUE_W = 40

const N_WANDER_ROWS = 7
const WANDER_PILL_H = PILL_PAD * 2 + N_WANDER_ROWS * ROW_H + (N_WANDER_ROWS - 1) * ROW_GAP

// Simulation constants
const MIN_SPEED_PX     = 20    // px/s, manual slider = 0
const MAX_SPEED_PX     = 400   // px/s, manual slider = 1
const SPEED_RATE_SCALE = 200   // bound Rate (Hz) -> px/s
const RATE_DISPLAY_MAX = 8     // matches RateLayer.MAX_RATE, for the slider bar
const MAX_DT           = 0.1   // seconds, capped to avoid jumps after a pause

const DRIFT_TURN_RATE    = 1.5  // rad/s at amount=1 (smooth heading drift)
const BROWNIAN_TURN_RATE = 2.5  // rad per step at amount=1 (sharp random turns)
const ORBIT_BASE_RATE    = 0.3  // rad/s at amount=0 (gentle curve)
const ORBIT_AMOUNT_RATE  = 3.0  // additional rad/s at amount=1 (tight spiral)
const WAVE_FREQ          = 2.0  // rad/s, oscillation frequency of the heading wave
const WAVE_TURN_RATE     = 2.0  // rad/s turning amplitude at amount=1

const TRACK_DRIFT_RADIUS = 100  // px, max drift-offset radius at amount=1
const TRACK_DRIFT_RATE   = 120  // px/s, random-walk step rate of the drift offset
const TRACK_LINE_STEP    = 2     // px, step size when searching along a line for the mask edge
const TRACK_MIN_FOLLOW_HZ = 2    // 1/s, sluggish follow at speed=0 (visible trailing lag)
const TRACK_MAX_FOLLOW_HZ = 150  // 1/s, effectively snaps within a frame at speed=1

const MASK_THRESHOLD  = 0.5   // alpha [0,1] above which a point is "inside" the mask
const EDGE_SAMPLE_EPS = 3      // px offset used to estimate the mask edge gradient
const SNAP_MAX_RADIUS = 150    // px, search radius for relocating a point left outside a moved/added mask
const COARSE_DIM      = 64     // px, side of the downsampled canvas used for the long-range mask search

export class PointLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  private readonly _slot:   ParameterSlot
  private readonly _region: DraggablePointRegion
  private _point: Point

  // Wander mode
  private readonly _wanderToggleSlot: ParameterSlot
  private readonly _amountSlot:       ParameterSlot
  private readonly _speedSlot:        ParameterSlot
  private readonly _maskSlot:         ParameterSlot

  private _wanderEnabled = false
  private _algoIndex     = 0          // index into WANDER_TYPES
  private _amount        = 0.4        // manual [0,1], used while amountSlot unbound
  private _speed         = 0.3        // manual [0,1], used while speedSlot unbound
  private _heading: number            // radians
  private _orbitSpin: number          // ±1, flips on each bounce in orbit mode
  private _wavePhase: number          // radians, advances over time in wave mode
  private _trackDrift = { x: 0, y: 0 } // px offset from the tracked target, random-walked in 'track' mode

  private _lastToggleTime: number | null = null   // wanderToggleSlot rising-edge detection
  private _lastTickTime:   number | null = null   // performance.now() of previous tick

  private _sliderDrag: 'amount' | 'speed' | null = null
  private _toggleBounds: BBox | null = null

  // Reused scratch canvas for the long-range (coarse) mask search.
  private _coarseCanvas: OffscreenCanvas | null = null

  constructor(initial: Point = { x: 200, y: 200 }) {
    super()
    this._point  = { ...initial }
    this._slot   = new ParameterSlot(ValueType.Point, this)
    this._region = new DraggablePointRegion(this, initial)
    this._heading   = Math.random() * Math.PI * 2
    this._orbitSpin = Math.random() < 0.5 ? 1 : -1
    this._wavePhase = Math.random() * Math.PI * 2

    this._wanderToggleSlot = new ParameterSlot(ValueType.Event,  this, 'wander')
    this._amountSlot       = new ParameterSlot(ValueType.Amount, this, 'amount')
    this._speedSlot        = new ParameterSlot(ValueType.Rate,   this, 'speed')
    this._maskSlot         = new ParameterSlot(ValueType.Mask,   this, 'mask')

    this.slots.push(
      this._slot,
      this._wanderToggleSlot, this._amountSlot, this._speedSlot, this._maskSlot,
    )
    this.debugName = 'PointLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // PointSource
  // ----------------------------------------------------------

  getPoint(): Point { return { ...this._point } }

  // ----------------------------------------------------------
  // Value
  // ----------------------------------------------------------

  // Called by the embedded DraggablePointRegion when the user drags.
  setPoint(p: Point): void {
    this._point = { ...p }
    this.markDirty()
  }

  protected override receiveValue(type: ValueType | null, val: Point | number | Direction): void {
    if (type !== ValueType.Point || typeof val !== 'object' || !('x' in val)) return
    if (this._slot.state === SlotState.Bound) BindingLayer.findForSlot(this._slot)?.toggle()
    this._point = { ...(val as Point) }
    this.markDirty()
  }

  get slot(): ParameterSlot { return this._slot }

  // ----------------------------------------------------------
  // Wander mode — slot accessors / manual controls
  // ----------------------------------------------------------

  get wanderToggleSlot(): ParameterSlot { return this._wanderToggleSlot }
  get amountSlot():       ParameterSlot { return this._amountSlot       }
  get speedSlot():        ParameterSlot { return this._speedSlot        }
  get maskSlot():         ParameterSlot { return this._maskSlot         }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the manual control, so the binding starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._slot)       return { ...this._point }
    if (slot === this._amountSlot) return this._amount
    return null
  }

  cycleNext(): void { this._algoIndex = (this._algoIndex + 1) % WANDER_TYPES.length; this.markDirty() }
  cyclePrev(): void { this._algoIndex = (this._algoIndex - 1 + WANDER_TYPES.length) % WANDER_TYPES.length; this.markDirty() }

  // Touching a slider while its slot is bound suspends the binding first,
  // handing manual control back to the user (same pattern as AmountLayer /
  // NoiseLayer / FillLayer).
  setAmount(v: number): void {
    if (this._amountSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._amountSlot)?.toggle()
    this._amount = Math.max(0, Math.min(1, v))
    this.markDirty()
  }

  setSpeed(v: number): void {
    if (this._speedSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._speedSlot)?.toggle()
    this._speed = Math.max(0, Math.min(1, v))
    this.markDirty()
  }

  // Manually operating the toggle hands permanent control to the user: a
  // bound event source is suspended (never resumed by this button — that
  // takes the binding-inspector's enable toggle), and from then on every
  // click simply flips `_wanderEnabled`.
  private _handleWanderToggle(): void {
    if (this._wanderToggleSlot.state === SlotState.Bound) {
      this._wanderToggleSlot.suspend()
    }
    this._wanderEnabled = !this._wanderEnabled
    if (this._wanderEnabled) this._lastTickTime = null
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this._slot.isActive) {
      const src = this._slot.source as PointSource
      this._point = src.getPoint()
      this._region.setPoint(this._point)
      this._region.interactive = false
      // Don't carry over a stale dt if wander resumes once this slot is unbound.
      this._lastTickTime = null
    } else {
      // Wander toggle — each rising edge flips _wanderEnabled.
      if (this._wanderToggleSlot.isActive) {
        const t = (this._wanderToggleSlot.source as EventSource).getEventTime()
        if (t !== null && t !== this._lastToggleTime) {
          this._lastToggleTime = t
          this._wanderEnabled = !this._wanderEnabled
          if (this._wanderEnabled) this._lastTickTime = null
        }
      }

      if (this._wanderEnabled) {
        this._region.interactive = false
        this._wanderTick()
      } else {
        this._region.interactive = true
        // Reflect the region's current dragged position.
        this._point = this._region.point
      }
      this._region.setPoint(this._point)
    }

    // Self-perpetuate: keep wandering every frame while enabled and in the
    // stack (or parked in BackgroundLayer). forceDirty() is called AFTER
    // evaluate() clears our dirty flag, so the next rAF finds us dirty and
    // advances the simulation again (same pattern as VideoLayer's frame loop).
    if (this._wanderEnabled && !this._slot.isActive && (!this.outsideStack || this.inBackground)) {
      queueMicrotask(() => {
        if (this._wanderEnabled && !this._slot.isActive && (!this.outsideStack || this.inBackground)) this.forceDirty()
      })
    }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      point:         this._point,
      wanderEnabled: this._wanderEnabled,
      algoIndex:     this._algoIndex,
      amount:        this._amount,
      speed:         this._speed,
      heading:       this._heading,
      orbitSpin:     this._orbitSpin,
      wavePhase:     this._wavePhase,
      trackDrift:    this._trackDrift,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.point && typeof state.point === 'object') {
      this._point = state.point as Point
      this._region.setPoint(this._point)
    }
    if (typeof state.wanderEnabled === 'boolean') this._wanderEnabled = state.wanderEnabled
    if (typeof state.algoIndex === 'number')      this._algoIndex     = state.algoIndex
    if (typeof state.amount === 'number')         this._amount        = state.amount
    if (typeof state.speed === 'number')          this._speed         = state.speed
    if (typeof state.heading === 'number')        this._heading       = state.heading
    if (typeof state.orbitSpin === 'number')      this._orbitSpin     = state.orbitSpin
    if (typeof state.wavePhase === 'number')      this._wavePhase     = state.wavePhase
    if (state.trackDrift && typeof state.trackDrift === 'object') {
      this._trackDrift = state.trackDrift as { x: number; y: number }
    }
  }

  // ----------------------------------------------------------
  // Wander simulation
  // ----------------------------------------------------------

  private _wanderTick(): void {
    const now = performance.now()
    if (this._lastTickTime === null) {
      this._lastTickTime = now
      return
    }
    const dt = Math.max(0, Math.min(MAX_DT, (now - this._lastTickTime) / 1000))
    this._lastTickTime = now
    if (dt === 0) return

    const amount = this._amountSlot.isActive
      ? Math.max(0, Math.min(1, (this._amountSlot.source as AmountSource).getAmount() as Amount))
      : this._amount

    const speedPx = this._speedSlot.isActive
      ? (this._speedSlot.source as RateSource).getRate() * SPEED_RATE_SCALE
      : MIN_SPEED_PX + this._speed * (MAX_SPEED_PX - MIN_SPEED_PX)

    const mask = this._maskSlot.isActive ? (this._maskSlot.source as MaskSource).getMask() : null

    // If the mask was just bound, or has moved/changed shape since the last
    // tick, the point may now be outside it. Relocate to the nearest
    // interior point, keeping heading/speed unchanged so the bounce logic
    // below can fire immediately if the new position sits right at the
    // mask edge.
    if (mask && this._boundaryNormal(this._point, mask) !== null) {
      const inside = this._nearestInsideMask(mask, this._point)
      if (inside !== null) this._point = inside
    }

    if (WANDER_TYPES[this._algoIndex] === 'track') {
      const speed01 = this._speedSlot.isActive
        ? Math.max(0, Math.min(1, (this._speedSlot.source as RateSource).getRate() / RATE_DISPLAY_MAX))
        : this._speed
      this._trackTick(dt, amount, speed01, mask)
      return
    }

    switch (WANDER_TYPES[this._algoIndex]) {
      case 'drift':
        // Forward motion with slight drifts left/right in heading direction.
        this._heading += (Math.random() * 2 - 1) * amount * DRIFT_TURN_RATE * dt
        break
      case 'brownian':
        // Sharp, independent random turns each step — drunken-walk character.
        this._heading += (Math.random() * 2 - 1) * amount * BROWNIAN_TURN_RATE
        break
      case 'orbit':
        // Constant-direction turning — circular/spiral paths. Spin direction
        // flips on each bounce (see below), like a spinning ball reversing
        // spin off a paddle.
        this._heading += this._orbitSpin * (ORBIT_BASE_RATE + amount * ORBIT_AMOUNT_RATE) * dt
        break
      case 'wave':
        // Heading oscillates sinusoidally over time, producing an S-curve
        // path. `amount` scales the turning-rate amplitude, not the phase
        // frequency, so it controls how tight the wiggle is.
        this._wavePhase += WAVE_FREQ * dt
        this._heading += Math.cos(this._wavePhase) * amount * WAVE_TURN_RATE * dt
        break
    }

    let vx = Math.cos(this._heading) * speedPx
    let vy = Math.sin(this._heading) * speedPx

    let next = { x: this._point.x + vx * dt, y: this._point.y + vy * dt }
    let bounced = false
    for (let attempt = 0; attempt < 2; attempt++) {
      const normal = this._boundaryNormal(next, mask)
      if (normal === null) break
      bounced = true
      const dot = vx * normal.x + vy * normal.y
      vx -= 2 * dot * normal.x
      vy -= 2 * dot * normal.y
      this._heading = Math.atan2(vy, vx)
      next = { x: this._point.x + vx * dt, y: this._point.y + vy * dt }
    }
    if (this._boundaryNormal(next, mask) !== null) next = { ...this._point }

    // Reverse orbit spin on bounce — like a spinning ball reversing spin off
    // a paddle. Only meaningful in orbit mode, but harmless to track always.
    if (bounced) this._orbitSpin = -this._orbitSpin

    this._point = next
  }

  // 'track' mode: follows Node.pointerCanvas (the mouse position), offset by
  // a slowly-wandering drift vector whose magnitude is capped by `amount`.
  // If a mask is bound, the tracked target is constrained to stay inside it
  // (see _lastInsidePointAlongLine), and the point exponentially eases
  // toward that target at a rate controlled by `speed01` — at speed01=1 the
  // point effectively snaps to the target within a frame; at speed01=0 it
  // trails behind with a visible lag.
  //
  // By this point _point is guaranteed to be inside `mask` (or mask is
  // null) thanks to the relocation step in _wanderTick, so it can be used
  // directly as the "last valid point inside the mask".
  private _trackTick(dt: number, amount: number, speed01: number, mask: MaskValue): void {
    const mouse = Node.pointerCanvas
    if (mouse === null) return

    // Random-walk the drift offset within a disc of radius amount * TRACK_DRIFT_RADIUS.
    const maxR = amount * TRACK_DRIFT_RADIUS
    this._trackDrift.x += (Math.random() * 2 - 1) * TRACK_DRIFT_RATE * dt
    this._trackDrift.y += (Math.random() * 2 - 1) * TRACK_DRIFT_RATE * dt
    const r = Math.hypot(this._trackDrift.x, this._trackDrift.y)
    if (r > maxR) {
      if (r > 1e-6) {
        this._trackDrift.x *= maxR / r
        this._trackDrift.y *= maxR / r
      } else {
        this._trackDrift.x = 0
        this._trackDrift.y = 0
      }
    }

    let target: Point
    if (mask) {
      const mouseInside = this._sampleMaskAlpha(mask, mouse.x, mouse.y) >= MASK_THRESHOLD
      const base = mouseInside ? mouse : this._lastInsidePointAlongLine(mask, this._point, mouse)
      const drifted = { x: base.x + this._trackDrift.x, y: base.y + this._trackDrift.y }
      // Drift may move the target back deeper inside the mask, but not out
      // of it — clip along the line from `base` (inside) to `drifted`.
      target = this._lastInsidePointAlongLine(mask, base, drifted)
    } else {
      target = { x: mouse.x + this._trackDrift.x, y: mouse.y + this._trackDrift.y }
    }

    // Exponentially ease toward the target, frame-rate independent. At
    // speed01=1, followHz is high enough to snap to the target within a
    // frame; at speed01=0 a slow follow rate produces a visible trailing lag.
    const followHz = TRACK_MIN_FOLLOW_HZ + speed01 * (TRACK_MAX_FOLLOW_HZ - TRACK_MIN_FOLLOW_HZ)
    const alpha = 1 - Math.exp(-followHz * dt)
    this._point = {
      x: this._point.x + (target.x - this._point.x) * alpha,
      y: this._point.y + (target.y - this._point.y) * alpha,
    }
  }

  // Marches from `from` (assumed inside `mask`) toward `to` in TRACK_LINE_STEP
  // increments, returning the last point still inside the mask before the
  // line crosses to an outside point. Returns `to` unchanged if the whole
  // line stays inside the mask, or `from` unchanged if even one step out
  // already lands outside.
  private _lastInsidePointAlongLine(mask: OffscreenCanvas, from: Point, to: Point): Point {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dist = Math.hypot(dx, dy)
    if (dist < 1e-6) return { ...from }

    const steps = Math.max(1, Math.ceil(dist / TRACK_LINE_STEP))
    let last = { ...from }
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const p = { x: from.x + dx * t, y: from.y + dy * t }
      if (this._sampleMaskAlpha(mask, p.x, p.y) < MASK_THRESHOLD) return last
      last = p
    }
    return last
  }

  // Returns the inward-pointing unit normal at `p` if it lies outside the
  // permitted area — the canvas bounds always apply, and (if a mask is
  // bound) the mask too — or null if `p` is inside both.
  private _boundaryNormal(p: Point, mask: MaskValue): { x: number; y: number } | null {
    // Canvas bounds take priority over the mask: mask-alpha sampling clamps
    // to the canvas-sized surface, so it can never report an edge beyond the
    // canvas — without this check, a mask shape extending past the canvas
    // would let the point wander off-canvas forever.
    const W = Node.canvasWidth
    const H = Node.canvasHeight
    let cnx = 0, cny = 0
    if (p.x < 0) cnx = 1
    else if (p.x > W) cnx = -1
    if (p.y < 0) cny = 1
    else if (p.y > H) cny = -1
    if (cnx !== 0 || cny !== 0) {
      const len = Math.hypot(cnx, cny)
      return { x: cnx / len, y: cny / len }
    }

    if (mask) {
      const a = this._sampleMaskAlpha(mask, p.x, p.y)
      if (a >= MASK_THRESHOLD) return null

      const aR = this._sampleMaskAlpha(mask, p.x + EDGE_SAMPLE_EPS, p.y)
      const aL = this._sampleMaskAlpha(mask, p.x - EDGE_SAMPLE_EPS, p.y)
      const aD = this._sampleMaskAlpha(mask, p.x, p.y + EDGE_SAMPLE_EPS)
      const aU = this._sampleMaskAlpha(mask, p.x, p.y - EDGE_SAMPLE_EPS)
      let nx = aR - aL
      let ny = aD - aU
      const len = Math.hypot(nx, ny)
      if (len < 1e-3) {
        // Flat alpha (deep outside, or degenerate mask) — fall back to
        // bouncing straight back the way we came.
        nx = this._point.x - p.x
        ny = this._point.y - p.y
        const l2 = Math.hypot(nx, ny)
        if (l2 < 1e-3) return { x: 0, y: -1 }
        return { x: nx / l2, y: ny / l2 }
      }
      return { x: nx / len, y: ny / len }
    }

    return null
  }

  private _sampleMaskAlpha(mask: OffscreenCanvas, x: number, y: number): number {
    const cx = Math.max(0, Math.min(mask.width  - 1, Math.round(x)))
    const cy = Math.max(0, Math.min(mask.height - 1, Math.round(y)))
    const ctx = mask.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return 0
    return ctx.getImageData(cx, cy, 1, 1).data[3]! / 255
  }

  // Finds the closest point with mask alpha >= MASK_THRESHOLD to `p`. Tries
  // a local search first (cheap — a single (2*SNAP_MAX_RADIUS)^2 pixel read
  // around `p`), which covers the common case of a mask that has moved or
  // resized only slightly. If the mask isn't found nearby (e.g. it was just
  // bound, or moved to a different part of the canvas), falls back to a
  // coarse whole-canvas search. Returns null only if the mask is empty
  // everywhere.
  private _nearestInsideMask(mask: OffscreenCanvas, p: Point): Point | null {
    return this._nearestInsideMaskLocal(mask, p) ?? this._nearestInsideMaskCoarse(mask, p)
  }

  private _nearestInsideMaskLocal(mask: OffscreenCanvas, p: Point): Point | null {
    const ctx = mask.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null

    const x0 = Math.max(0, Math.floor(p.x - SNAP_MAX_RADIUS))
    const y0 = Math.max(0, Math.floor(p.y - SNAP_MAX_RADIUS))
    const x1 = Math.min(mask.width,  Math.ceil(p.x + SNAP_MAX_RADIUS))
    const y1 = Math.min(mask.height, Math.ceil(p.y + SNAP_MAX_RADIUS))
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) return null

    const data = ctx.getImageData(x0, y0, w, h).data
    let best: Point | null = null
    let bestDist = Infinity
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3]! / 255 < MASK_THRESHOLD) continue
        const cx = x0 + x
        const cy = y0 + y
        const d = Math.hypot(cx - p.x, cy - p.y)
        if (d < bestDist) { bestDist = d; best = { x: cx, y: cy } }
      }
    }
    return best
  }

  // Long-range fallback: downsamples the whole mask onto a small
  // COARSE_DIM x COARSE_DIM canvas (one drawImage + one small getImageData,
  // independent of the mask's actual resolution) and returns the centre of
  // the nearest opaque cell, in full-canvas coordinates. A later tick's
  // local search (now within SNAP_MAX_RADIUS) refines onto the actual edge.
  private _nearestInsideMaskCoarse(mask: OffscreenCanvas, p: Point): Point | null {
    if (mask.width <= 0 || mask.height <= 0) return null
    if (!this._coarseCanvas) this._coarseCanvas = new OffscreenCanvas(COARSE_DIM, COARSE_DIM)
    const canvas = this._coarseCanvas
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null

    const cw = Math.min(COARSE_DIM, mask.width)
    const ch = Math.min(COARSE_DIM, mask.height)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, cw, ch)

    const data = ctx.getImageData(0, 0, cw, ch).data
    const sx = mask.width  / cw
    const sy = mask.height / ch
    let best: Point | null = null
    let bestDist = Infinity
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (data[(y * cw + x) * 4 + 3]! / 255 < MASK_THRESHOLD) continue
        const cx = (x + 0.5) * sx
        const cy = (y + 0.5) * sy
        const d = Math.hypot(cx - p.x, cy - p.y)
        if (d < bestDist) { bestDist = d; best = { x: cx, y: cy } }
      }
    }
    return best
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  // Wander-pill controls and the toggle button (in its slot row) take
  // priority; otherwise delegate to the handle's hit-test zone, not the
  // label bar.
  protected override hitTestSelf(point: Point) {
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) return this
    if (this._hitWanderControls(point)) return this
    return this._region.hitTest(point)
  }

  private _hitWanderControls(point: Point): boolean {
    const { prev, label, next } = this._modeButtons(this._wanderRow(1))
    if (boundingBoxContains(prev,  point)) return true
    if (boundingBoxContains(label, point)) return true
    if (boundingBoxContains(next,  point)) return true

    for (const i of [2, 4]) {
      const row = this._wanderRow(i)
      const { sld0, sldR } = this._sliderGeom(row)
      if (point.x >= sld0 - 6 && point.x <= sldR + 6 &&
          point.y >= row.y  && point.y <= row.y + row.height) return true
    }
    return false
  }

  handlePointerDown(point: Point): boolean {
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) {
      this._handleWanderToggle()
      return true
    }

    const { prev, label, next } = this._modeButtons(this._wanderRow(1))
    if (boundingBoxContains(prev,  point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(label, point)) { this.cycleNext(); return true }
    if (boundingBoxContains(next,  point)) { this.cycleNext(); return true }

    for (const i of [2, 4]) {
      const row = this._wanderRow(i)
      const { sld0, sldR } = this._sliderGeom(row)
      if (point.x >= sld0 - 6 && point.x <= sldR + 6 &&
          point.y >= row.y  && point.y <= row.y + row.height) {
        this._sliderDrag = i === 2 ? 'amount' : 'speed'
        this._setSliderFromPointer(this._sliderDrag, point.x)
        return true
      }
    }
    return false
  }

  handlePointerMove(point: Point): void {
    if (this._sliderDrag === null) return
    this._setSliderFromPointer(this._sliderDrag, point.x)
  }

  handlePointerUp(): void {
    this._sliderDrag = null
  }

  private _setSliderFromPointer(which: 'amount' | 'speed', px: number): void {
    const row = this._wanderRow(which === 'amount' ? 2 : 4)
    const { sld0, sldR } = this._sliderGeom(row)
    const thumbR = 5
    const lo     = sld0 + thumbR
    const hi     = sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    const v      = Math.max(0, Math.min(1, (px - lo) / range))
    if (which === 'amount') this.setAmount(v)
    else this.setSpeed(v)
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds

    // ── Label bar (canvas panel) ───────────────────────────
    if (width > 0 && height > 0) {
      ctx.save()

      // Background pill
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
      ctx.fill()

      // Accent stripe
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
      ctx.fill()

      // Coordinate label
      const px = Math.round(this._point.x)
      const py = Math.round(this._point.y)
      ctx.font         = '11px monospace'
      ctx.fillStyle    = this._slot.isActive
        ? 'rgba(255,255,255,0.55)'
        : 'rgba(255,255,255,0.80)'
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`(${px}, ${py})`, x + 12, y + height / 2)

      ctx.restore()
    }

    // ── Draggable handle (anywhere on canvas) ─────────────
    this._region.renderSelf(ctx)
  }

  // Everything below the coordinate-readout pill — the Point-binding row
  // and the consolidated wander pill — is drawn by renderSlots(), so
  // panelBottom just needs to return the bottom of that stack.
  override get panelBottom(): number {
    const wb = this._wanderPillBounds()
    return wb.y + wb.height + 8
  }

  // Draws, in order: the main Point-binding row (its own small pill), then
  // the consolidated wander pill (rows 1-7: wander toggle binding, mode
  // cycler, amount slider, amount binding, speed slider, speed binding,
  // mask binding).
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()

    // ── Point-source binding row ───────────────────────────
    const pb = this._pointSlotPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(pb.x, pb.y, pb.width, pb.height, 6); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(pb.x, pb.y, 4, pb.height, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()
    this._renderSlotRow(ctx, this._slot, pb)

    // ── Wander pill ─────────────────────────────────────────
    const wb = this._wanderPillBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath(); ctx.roundRect(wb.x, wb.y, wb.width, wb.height, 8); ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath(); ctx.roundRect(wb.x, wb.y, 4, wb.height, [4, 0, 0, 4]); ctx.fill()
    ctx.restore()

    // Row 1 — wander-enable binding + on/off toggle
    const row1 = this._wanderRow(0)
    this._renderSlotRow(ctx, this._wanderToggleSlot, row1)
    this._renderWanderToggleButton(ctx, row1)

    // Row 2 — algorithm cycler
    this._renderModeRow(ctx, this._wanderRow(1))

    // Row 3 — amount slider
    const amountVal = this._amountSlot.isActive
      ? Math.max(0, Math.min(1, (this._amountSlot.source as AmountSource).getAmount() as Amount))
      : this._amount
    this._renderSliderRow(
      ctx, this._wanderRow(2), this._amountSlot, 'amount', AM_ACCENT,
      amountVal, amountVal.toFixed(2),
    )

    // Row 4 — amount binding
    this._renderSlotRow(ctx, this._amountSlot, this._wanderRow(3))

    // Row 5 — speed slider
    let speedVal01: number
    let speedText: string
    if (this._speedSlot.isActive) {
      const rate = (this._speedSlot.source as RateSource).getRate()
      speedVal01 = Math.max(0, Math.min(1, rate / RATE_DISPLAY_MAX))
      speedText  = rate.toFixed(2)
    } else {
      speedVal01 = this._speed
      speedText  = this._speed.toFixed(2)
    }
    this._renderSliderRow(
      ctx, this._wanderRow(4), this._speedSlot, 'speed', RATE_ACCENT,
      speedVal01, speedText,
    )

    // Row 6 — speed binding
    this._renderSlotRow(ctx, this._speedSlot, this._wanderRow(5))

    // Row 7 — mask binding
    this._renderSlotRow(ctx, this._maskSlot, this._wanderRow(6))
  }

  // Standard slot-binding row (label + drop-target box), reimplemented from
  // Layer.renderSlots so it can be drawn at an arbitrary BBox rather than the
  // fixed per-slot grid — registers `_slotBounds` for hitTestSlot/bind-drop.
  private _renderSlotRow(ctx: Ctx2D, slot: ParameterSlot, b: BBox): void {
    const drag = Node.bindDrag
    const isCompat = (drag.active && drag.source !== null && slot.type !== null
                      && drag.source.types.has(slot.type))
                  || (Node.fileDragActive && slot.type === ValueType.Image
                      && slot.state === SlotState.Unbound)

    this._slotBounds.set(slot, b)

    const midY = b.y + b.height / 2
    ctx.save()
    ctx.font         = '10px monospace'
    ctx.textBaseline = 'middle'

    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.textAlign = 'left'
    ctx.fillText(slot.label, b.x + 6, midY)

    const tc = (slot.type !== null ? TYPE_COLOUR[slot.type] : undefined) ?? '#888888'
    const vx = b.x + LABEL_W
    const vw = b.width - LABEL_W - 2
    const by = b.y + 3
    const bh = b.height - 6

    if (slot.isActive && !isCompat) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = tc + '22'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = tc + 'cc'; ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left'
      ctx.fillText(srcName, vx + 6, midY)
    } else if (isCompat) {
      ctx.fillStyle = 'rgba(50,200,70,0.18)'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(50,200,70,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.fillStyle = 'rgba(100,255,120,0.75)'; ctx.textAlign = 'left'
      ctx.fillText(slot.isActive ? 'replace binding' : 'drop to bind', vx + 6, midY)
    } else if (slot.state === SlotState.SuspendedBound) {
      const srcName = (slot.source as { debugName?: string } | null)?.debugName ?? '?'
      ctx.fillStyle = tc + '11'
      ctx.beginPath(); ctx.roundRect(vx, by, vw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.40)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.60)'; ctx.textAlign = 'left'
      ctx.fillText('⏸ ' + srcName, vx + 6, midY)
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.roundRect(vx + 0.5, by + 0.5, vw - 1, bh - 1, 4); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.textAlign = 'left'
      ctx.fillText('unbound', vx + 6, midY)
    }

    ctx.restore()
  }

  // Slider row — label, track, and resolved value. Tinted with
  // `activeColour` when `slot` is bound (visual link to its binding row,
  // drawn separately by _renderSlotRow). No drop target of its own.
  private _renderSliderRow(
    ctx: Ctx2D, b: BBox, slot: ParameterSlot, label: string,
    activeColour: string, value01: number, valueText: string,
  ): void {
    const midY = b.y + b.height / 2
    const { sld0, sldR, valueRight } = this._sliderGeom(b)
    const colour = slot.state === SlotState.Bound ? activeColour : ACCENT

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + 8, midY)

    this._drawSlider(ctx, midY, sld0, sldR, value01, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(valueText, valueRight, midY)
  }

  // Row 2 content — [◀] <algorithm> [▶] cycler, no slot binding.
  private _renderModeRow(ctx: Ctx2D, b: BBox): void {
    const midY = b.y + b.height / 2
    const { prev, label, next } = this._modeButtons(b)

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('mode', b.x + 8, midY)

    this._drawNavBtn(ctx, prev, '◀', midY)
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath(); ctx.roundRect(label.x, label.y, label.width, label.height, 3); ctx.fill()
    ctx.font      = '11px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'center'
    ctx.fillText(WANDER_TYPES[this._algoIndex]!, label.x + label.width / 2, midY)
    this._drawNavBtn(ctx, next, '▶', midY)
  }

  // Row 1's on/off toggle button, drawn at the right edge of the wander-
  // toggle slot row — same convention as VideoLayer's freeze toggle /
  // ShapeLayer's event-slot toggles.
  private _renderWanderToggleButton(ctx: Ctx2D, row: BBox): void {
    const BTN_SZ = row.height - 6
    const btnX   = row.x + row.width - BTN_SZ - 3
    const btnY   = row.y + 3
    const midY   = row.y + row.height / 2

    this._toggleBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }

    const state       = this._wanderToggleSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound

    ctx.save()

    if (isActive) ctx.fillStyle = EV_ACCENT + '33'
    else if (isSuspended) ctx.fillStyle = 'rgba(255,255,255,0.10)'
    else ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, BTN_SZ, BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? EV_ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_SZ - 1, BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font         = '11px monospace'
    ctx.fillStyle    = this._wanderEnabled ? EV_ACCENT : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(this._wanderEnabled ? '⏺' : '⏸', btnX + BTN_SZ / 2, midY)

    ctx.restore()
  }

  // Track + filled portion + thumb, FilterLayer/NoiseLayer slider style.
  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap = 'round'

    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(hi, midY)
    ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(lo, midY)
    ctx.lineTo(thumbX, midY)
    ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2)
    ctx.fill()
  }

  private _drawNavBtn(ctx: Ctx2D, b: BBox, label: string, midY: number): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.font         = '9px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  // ----------------------------------------------------------
  // Layout
  // ----------------------------------------------------------

  // Single-row pill for the main Point binding (`slot`) — directly below
  // the coordinate-readout pill.
  private _pointSlotPillBounds(): BBox {
    const cb = this.canvasBounds
    return { x: cb.x, y: cb.y + cb.height + 8, width: cb.width, height: ROW_H }
  }

  // The consolidated wander pill — directly below the Point-binding row.
  private _wanderPillBounds(): BBox {
    const pb = this._pointSlotPillBounds()
    return { x: pb.x, y: pb.y + pb.height + 8, width: pb.width, height: WANDER_PILL_H }
  }

  // Row `i` (0-4) within the wander pill.
  private _wanderRow(i: number): BBox {
    const b = this._wanderPillBounds()
    return { x: b.x, y: b.y + PILL_PAD + i * (ROW_H + ROW_GAP), width: b.width, height: ROW_H }
  }

  // [◀] <algo> [▶] button geometry within row `b`.
  private _modeButtons(b: BBox): { prev: BBox; label: BBox; next: BBox } {
    const by = b.y + (b.height - BTN_H) / 2
    let cx = b.x + LABEL_W
    const prev = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 4
    const label = { x: cx, y: by, width: MODE_LABEL_W, height: BTN_H }
    cx += MODE_LABEL_W + 4
    const next = { x: cx, y: by, width: BTN_W, height: BTN_H }
    return { prev, label, next }
  }

  // Slider track + value geometry within row `b`.
  private _sliderGeom(b: BBox): { sld0: number; sldR: number; valueRight: number } {
    const valueRight = b.x + b.width - 8
    const sld0       = b.x + LABEL_W
    const sldR       = valueRight - SLIDER_VALUE_W - 6
    return { sld0, sldR, valueRight }
  }
}
