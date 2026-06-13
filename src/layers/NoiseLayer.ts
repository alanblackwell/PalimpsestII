import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Amount,     type AmountSource,
  type Point,      type PointSource,
  type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'
import { noiseGL, type GLNoiseId } from './NoiseGL.js'

// ------------------------------------------------------------
// NoiseLayer — procedural noise generator
// ------------------------------------------------------------
//
// Produces both an Amount (1-D sample at the current position) and
// an Image (256 × 256 greyscale noise texture, blit-scaled to fill
// the canvas in renderSelf).
//
// Noise types — cycled with [◀] / [▶]:
//
//   static  — (default) TV-snow: a persistent grid of random greyscale cell
//             values, a random subset of which is re-rolled every frame.
//   colour  — as 'static', but each re-rolled cell gets an independent
//             random value per RGB channel instead of one shared grey value.
//   cracks  — Worley/cellular (F1−F0): thin bright fracture lines on a
//             dark ground, like cracked glass slowly re-settling.
//   ripples — interference of several independent expanding rings
//             (raindrops on a puddle), each with its own period/phase.
//   warp    — domain-warped fBm: a second noise field continuously
//             distorts the sampling coordinates, producing organic,
//             non-directional drift (no single "scroll" axis).
//   organic — warp, modulated by a Worley cell mask, for a mottled,
//             living-tissue-like combination of the two.
//
// static/colour are stateful (depend on their own previous frame, via
// _staticGrid), not a pure function of (seed, t, x, y) like the rest.
// cracks/ripples/warp/organic use a purely arithmetic hash (no look-up
// table) so they are fully deterministic given seed + input coordinates.
//
// GPU acceleration (see NoiseGL.ts): for cracks/ripples/warp/organic, when
// WebGL is available the texture is rendered by a fragment shader at
// GL_NOISE_SIZE (1024) instead of the CPU loop at NOISE_SIZE (256) — finer
// detail and full frame-rate regeneration. The GPU hash uses different
// (smaller-magnitude) coefficients than the CPU hash for float32 precision,
// so it produces a different but equally-valid pseudorandom field (for
// 'ripples' this means the GPU's drop positions/timings differ from the
// CPU's _drops array, same "raindrop" character); the Amount output (a
// single sample) is always computed on the CPU. static/colour are CPU-only
// — their per-cell state (_staticGrid) lives on the layer instance, which
// doesn't fit NoiseGL's stateless single-pass shader model, and a 256×256
// grid of Math.random() calls is already as cheap as this gets.
//
// Time / speed model:
//   timeSlot  (Amount) — raw, unbounded elapsed seconds. Auto-bound at
//             creation directly to the shared Clock (see main.ts) — no
//             modulo wrap, so there is no periodic "pop" in the overall
//             texture. If unbound, time is frozen at 0.
//   speedSlot (Amount) — "speed": multiplies elapsed time to give the
//             evolution rate actually used by the noise field. Manual
//             control: [−]/[+] stepper, initialised to a random, gentle
//             per-instance value. For static/colour this instead directly
//             scales the fraction of grid cells re-rolled each frame
//             (0 = frozen).
//
// Other input slots:
//   scaleSlot    (Amount)    — "scale": maps [0, 1] → frequency [0.5, 16].
//                               For static/colour this sets the grid
//                               granularity (cell size from ~32px down to 1px).
//   detailSlot   (Amount)    — "warp": algorithm-specific detail/strength
//                               (crack thickness, ripple density, warp
//                               displacement, organic mix). Manual [−]/[+].
//                               Unused by static/colour.
//   driftSlot    (Direction) — "drift": orientation (+ strength via
//                               magnitude) of the anisotropic component of
//                               each algorithm's animation. Manual [‹]/[›]
//                               steps the angle in 22.5° increments.
//                               Unused by static/colour.
//   positionSlot (Point)     — "sample": canvas point at which the Amount
//                               output is read from the noise texture.
//
// Manual controls:
//   [◀] / [▶]     — cycle noise type
//   seed  [−][+]  — integer seed (0–99), shifts the hash domain
//   speed [−][+]  — evolution speed, 0–1
//   warp  [−][+]  — detail/strength amount, 0–1
//   drift [‹][›]  — drift direction, in 22.5° steps
//
// Touching any of speed/warp/drift while its slot is bound suspends that
// binding (same slider-override pattern as AmountLayer), handing manual
// control back to the user at the current effective value.
//
// Visual layout (two rows, height ≈ 78 px):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ ▌ [◀] cracks [▶]   seed [−] 7 [+]        time ●  pos ○  scale ○│
//   │   speed [−] 0.15 [+]  warp [−] 0.50 [+]  drift [‹] 90° [›]  …  │
//   └──────────────────────────────────────────────────────────────┘
//
// The noise texture is rendered full-canvas below the panel; it
// fades to a semi-transparent overlay so underlying layers show
// through slightly.

// ------------------------------------------------------------------
// Hash / value-noise primitives
// ------------------------------------------------------------------

function fract(n: number): number { return n - Math.floor(n) }

// Fast deterministic hash → [0, 1)
function h(n: number): number {
  return fract(Math.sin(n) * 43758.5453123)
}

function hash2(x: number, y: number, seed: number): number {
  return h(Math.floor(x) * 127.1 + Math.floor(y) * 311.7 + seed * 43758.5)
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t) }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = smoothstep(x - ix)
  const fy = smoothstep(y - iy)
  return lerp(
    lerp(hash2(ix,   iy,   seed), hash2(ix+1, iy,   seed), fx),
    lerp(hash2(ix,   iy+1, seed), hash2(ix+1, iy+1, seed), fx),
    fy,
  )
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let v = 0, a = 0.5, f = 1
  for (let i = 0; i < octaves; i++) { v += a * valueNoise(x*f, y*f, seed); a *= 0.5; f *= 2 }
  return v
}

// Smooth 0→1 ramp between edge0 and edge1, clamped.
function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// ------------------------------------------------------------------
// Cellular (Worley) noise — animated feature points
// ------------------------------------------------------------------

type DriftDir = { angle: number; magnitude: number }

// The feature point for cell (cx, cy): orbits its cell origin slowly over
// evolveTime `t`. The orbit is squashed/elongated perpendicular to `drift`,
// so the cell pattern drifts with an anisotropic bias rather than uniformly
// scrolling.
function cellPoint(cx: number, cy: number, seed: number, t: number, drift: DriftDir): Point {
  const baseX = hash2(cx, cy, seed)
  const baseY = hash2(cx, cy, seed + 17.3)
  const phase = hash2(cx, cy, seed + 91.7) * Math.PI * 2
  const speed = 0.4 + hash2(cx, cy, seed + 53.9) * 0.5

  let ox = Math.cos(t * speed + phase) * 0.32
  let oy = Math.sin(t * speed + phase) * 0.32

  const c = Math.cos(-drift.angle), s = Math.sin(-drift.angle)
  let rx = ox * c - oy * s
  let ry = ox * s + oy * c
  ry *= (1 - drift.magnitude * 0.8)
  ox = rx * Math.cos(drift.angle) - ry * Math.sin(drift.angle)
  oy = rx * Math.sin(drift.angle) + ry * Math.cos(drift.angle)

  return { x: cx + baseX + ox, y: cy + baseY + oy }
}

// Nearest (f0) and second-nearest (f1) feature-point distances.
function worley(x: number, y: number, seed: number, t: number, drift: DriftDir): { f0: number; f1: number } {
  const ix = Math.floor(x), iy = Math.floor(y)
  let f0 = 1e9, f1 = 1e9
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const p = cellPoint(ix + ox, iy + oy, seed, t, drift)
      const d = Math.hypot(x - p.x, y - p.y)
      if (d < f0) { f1 = f0; f0 = d } else if (d < f1) { f1 = d }
    }
  }
  return { f0, f1 }
}

// ------------------------------------------------------------------
// Ripple (interference) noise — independent expanding rings
// ------------------------------------------------------------------

type Drop = { cx: number; cy: number; speed: number; freq: number; period: number; phase0: number }

const MAX_DROPS = 12

function dropParams(i: number, seed: number): Drop {
  return {
    cx:     hash2(i, 0, seed),
    cy:     hash2(i, 1, seed),
    speed:  0.5 + hash2(i, 2, seed) * 1.0,
    freq:   16 + hash2(i, 3, seed) * 18,
    period: 2.5 + hash2(i, 4, seed) * 4,
    phase0: hash2(i, 5, seed) * 10,
  }
}

function ripplesValue(
  x: number, y: number, t: number,
  drift: DriftDir, detail: number, drops: readonly Drop[], freq: number,
): number {
  const n = Math.max(3, Math.round(detail * MAX_DROPS))
  const c = Math.cos(-drift.angle), s = Math.sin(-drift.angle)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = drops[i]!
    // Drop centres are stored normalised to [0,1) and scaled by the
    // current frequency here, so drops cover the full sampled domain
    // [0, freq) instead of clustering in one corner at freq > 1.
    const dx = x - d.cx * freq, dy = y - d.cy * freq
    let rx = dx * c - dy * s
    let ry = dx * s + dy * c
    ry *= (1 + drift.magnitude * 1.5)
    const dist = Math.hypot(rx, ry)

    const phase  = t * 4 + d.phase0
    const localT = fract(phase / d.period)
    const ringR  = localT * 0.9
    const env    = Math.exp(-(((dist - ringR) * 9) ** 2)) * (1 - localT)
    sum += Math.sin(dist * d.freq - phase * d.speed * 6) * env
  }
  // Each drop's contribution is a localised ring (env is mostly 0), so at
  // most a couple of drops are "active" at any given pixel — dividing by n
  // (up to MAX_DROPS) would crush a single ring's full ±1 swing down to
  // ±1/n, leaving the whole field near-uniform grey. Sum directly instead;
  // the result is clamped to [0,1] by the caller, so overlapping rings just
  // clip rather than overflow.
  return sum * 0.5 + 0.5
}

// ------------------------------------------------------------------
// Domain-warped fBm — non-directional organic drift
// ------------------------------------------------------------------

function warpValue(x: number, y: number, t: number, seed: number, drift: DriftDir, detail: number): number {
  // The warp field itself evolves with time; sampling its (continuously
  // changing) output as an offset makes the final pattern morph and swirl
  // rather than slide in a single direction.
  const wx = fbm(x * 0.6 + t * 0.5, y * 0.6 - t * 0.3, seed + 11, 2)
  const wy = fbm(x * 0.6 - t * 0.3, y * 0.6 + t * 0.5, seed + 53, 2)

  let qx = wx - 0.5, qy = wy - 0.5
  const c = Math.cos(drift.angle), s = Math.sin(drift.angle)
  const rqx = qx * c - qy * s
  const rqy = qx * s + qy * c

  const strength = detail * 4 * (0.4 + 0.6 * drift.magnitude)
  return fbm(x + rqx * strength, y + rqy * strength, seed, 4)
}

function organicValue(x: number, y: number, t: number, seed: number, drift: DriftDir, detail: number): number {
  const w = warpValue(x, y, t, seed, drift, detail)
  const { f0 } = worley(x, y, seed, t, drift)
  const cell = Math.min(1, f0 * 1.4)
  return w * (0.25 + 0.75 * cell)
}

// ------------------------------------------------------------------
// Dispatch
// ------------------------------------------------------------------

type NoiseId = 'static' | 'colour' | 'cracks' | 'ripples' | 'warp' | 'organic'
const NOISE_TYPES: NoiseId[] = ['static', 'colour', 'cracks', 'ripples', 'warp', 'organic']

// static/colour are stateful (their own previous-frame grid) and handled
// separately in _generateTexture/recompute — sampleNoise covers the four
// pure-function algorithms only.
type SampledNoiseId = Exclude<NoiseId, 'static' | 'colour'>

function sampleNoise(
  type: SampledNoiseId, x: number, y: number, seed: number, t: number,
  drift: DriftDir, detail: number, drops: readonly Drop[], freq: number,
): number {
  switch (type) {
    case 'cracks': {
      const { f0, f1 } = worley(x, y, seed, t, drift)
      const width = 0.02 + (1 - detail) * 0.3
      return 1 - smooth01(0, width, f1 - f0)
    }
    case 'ripples': return ripplesValue(x, y, t, drift, detail, drops, freq)
    case 'warp':    return warpValue(x, y, t, seed, drift, detail)
    case 'organic': return organicValue(x, y, t, seed, drift, detail)
  }
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT     = '#b8a050'   // warm amber — noise / procedural
const NOISE_SIZE = 256         // internal noise texture resolution (CPU path)
const GL_NOISE_SIZE = 1024     // internal noise texture resolution (GPU path)

const DEFAULT_FREQ = 3.0
const MIN_FREQ   = 0.5
const MAX_FREQ   = 16.0

// elapsed seconds × speedAmount[0,1] × SPEED_SCALE → evolveTime
const SPEED_SCALE = 0.3
const SPEED_STEP  = 0.05
const DETAIL_STEP = 0.05
const DRIFT_STEP  = Math.PI / 8   // 22.5°

// static/colour — TV-snow grid. Granularity (cells per axis) scales linearly
// with frequency: MIN_FREQ → ~8 cells (32px blocks), MAX_FREQ → NOISE_SIZE
// cells (1px, full pixel-wise noise). At speedAmount = 1, this fraction of
// cells is re-rolled to a fresh Math.random() value (or, for 'colour', three
// independent values) every frame.
const STATIC_GRID_PER_FREQ   = 16
const STATIC_UPDATE_FRACTION = 0.15

// Fixed anisotropy strength used when driftSlot is unbound.
const MANUAL_DRIFT_MAGNITUDE = 0.5

// Panel layout
const ROW_H   = 33
const ROW_GAP = 4
const PAD     = 4
const BTN_W   = 18
const BTN_H   = 22

type BBox = { x: number; y: number; width: number; height: number }

// ------------------------------------------------------------------
// NoiseLayer
// ------------------------------------------------------------------

export class NoiseLayer extends Layer implements AmountSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Image])

  private readonly _timeSlot:     ParameterSlot
  private readonly _speedSlot:    ParameterSlot
  private readonly _scaleSlot:    ParameterSlot
  private readonly _detailSlot:   ParameterSlot
  private readonly _positionSlot: ParameterSlot
  private readonly _driftSlot:    ParameterSlot

  private _noiseIndex: number = 0       // default: static
  private _seed:       number = 0
  private _amountOut:  number = 0

  // 256×256 noise texture (returned as ImageValue)
  private _noiseCanvas: OffscreenCanvas

  // Manual values, used while the corresponding slot is unbound.
  private _speed:      number   // [0, 1]
  private _detail:     number = 0.5
  private _driftAngle: number   // radians

  // Resolved each recompute
  private _frequency:  number = DEFAULT_FREQ
  private _evolveTime: number = 0
  private _speedAmt:   number = 0
  private _detailEff:  number = 0.5
  private _drift:      DriftDir = { angle: 0, magnitude: MANUAL_DRIFT_MAGNITUDE }
  private _samplePos:  Point = { x: 128, y: 128 }
  private _drops:      Drop[] = []

  // static/colour — persistent grid of cell RGB values (3 floats/cell), a
  // subset re-rolled each frame (see _updateStatic). 'static' reads only the
  // R channel; 'colour' reads all three. NOISE_SIZE × NOISE_SIZE cells so any
  // grid size up to full pixel resolution can be indexed without reallocation.
  private _staticGrid:     Float32Array = new Float32Array(NOISE_SIZE * NOISE_SIZE * 3)
  private _staticGridSize: number = NOISE_SIZE

  constructor() {
    super()
    this._noiseCanvas = new OffscreenCanvas(NOISE_SIZE, NOISE_SIZE)

    // Gentle, distinctive per-instance defaults.
    this._speed      = 0.05 + Math.random() * 0.25
    this._driftAngle = Math.random() * Math.PI * 2

    this._reshuffleStatic()

    this._timeSlot     = new ParameterSlot(ValueType.Amount,    this, 'time')
    this._speedSlot    = new ParameterSlot(ValueType.Amount,    this, 'speed')
    this._scaleSlot    = new ParameterSlot(ValueType.Amount,    this, 'scale')
    this._detailSlot   = new ParameterSlot(ValueType.Amount,    this, 'warp')
    this._positionSlot = new ParameterSlot(ValueType.Point,     this, 'sample')
    this._driftSlot    = new ParameterSlot(ValueType.Direction, this, 'drift')
    this.slots.push(
      this._timeSlot, this._speedSlot, this._scaleSlot,
      this._detailSlot, this._positionSlot, this._driftSlot,
    )

    for (let i = 0; i < MAX_DROPS; i++) this._drops.push(dropParams(i, this._seed))

    this.debugName = 'NoiseLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Sources
  // ----------------------------------------------------------

  getAmount(): Amount     { return this._amountOut   }
  getImage():  ImageValue { return this._noiseCanvas }

  // Wider than the default 260px canvas pill, to fit two rows of controls.
  override get canvasBounds(): { x: number; y: number; width: number; height: number } {
    return { ...super.canvasBounds, width: 460 }
  }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get timeSlot():     ParameterSlot { return this._timeSlot     }
  get speedSlot():    ParameterSlot { return this._speedSlot    }
  get scaleSlot():    ParameterSlot { return this._scaleSlot    }
  get detailSlot():   ParameterSlot { return this._detailSlot   }
  get positionSlot(): ParameterSlot { return this._positionSlot }
  get driftSlot():    ParameterSlot { return this._driftSlot    }

  // ----------------------------------------------------------
  // Cycling / seed / manual parameters
  // ----------------------------------------------------------

  cycleNext(): void { this._noiseIndex = (this._noiseIndex + 1) % NOISE_TYPES.length; this.markDirty() }
  cyclePrev(): void { this._noiseIndex = (this._noiseIndex - 1 + NOISE_TYPES.length) % NOISE_TYPES.length; this.markDirty() }
  incrSeed():  void {
    this._seed = (this._seed + 1) % 100
    for (let i = 0; i < MAX_DROPS; i++) this._drops[i] = dropParams(i, this._seed)
    this._reshuffleStatic()
    this.markDirty()
  }
  decrSeed():  void {
    this._seed = (this._seed - 1 + 100) % 100
    for (let i = 0; i < MAX_DROPS; i++) this._drops[i] = dropParams(i, this._seed)
    this._reshuffleStatic()
    this.markDirty()
  }

  // 'static' has no deterministic seed-dependence (it's pure Math.random()),
  // but reshuffling the whole grid on seed change still gives the seed
  // button a visible "fresh snow" effect, consistent with the other
  // algorithms shifting their pattern.
  private _reshuffleStatic(): void {
    for (let i = 0; i < this._staticGrid.length; i++) this._staticGrid[i] = Math.random()
  }

  // Touching a manual control while its slot is bound suspends the
  // binding first, handing control back to the user at the current value.
  private _bumpAmount(slot: ParameterSlot, get: () => number, set: (v: number) => void, delta: number): void {
    if (slot.state === SlotState.Bound) BindingLayer.findForSlot(slot)?.toggle()
    set(Math.max(0, Math.min(1, get() + delta)))
    this.markDirty()
  }

  incrSpeed():  void { this._bumpAmount(this._speedSlot,  () => this._speed,  v => this._speed  = v, SPEED_STEP)  }
  decrSpeed():  void { this._bumpAmount(this._speedSlot,  () => this._speed,  v => this._speed  = v, -SPEED_STEP) }
  incrDetail(): void { this._bumpAmount(this._detailSlot, () => this._detail, v => this._detail = v, DETAIL_STEP)  }
  decrDetail(): void { this._bumpAmount(this._detailSlot, () => this._detail, v => this._detail = v, -DETAIL_STEP) }

  private _bumpDrift(delta: number): void {
    if (this._driftSlot.state === SlotState.Bound) BindingLayer.findForSlot(this._driftSlot)?.toggle()
    const twoPi = Math.PI * 2
    this._driftAngle = ((this._driftAngle + delta) % twoPi + twoPi) % twoPi
    this.markDirty()
  }
  incrDrift(): void { this._bumpDrift(DRIFT_STEP)  }
  decrDrift(): void { this._bumpDrift(-DRIFT_STEP) }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const elapsed = this._timeSlot.isActive
      ? (this._timeSlot.source as AmountSource).getAmount() as Amount
      : 0

    this._frequency = this._scaleSlot.isActive
      ? MIN_FREQ + ((this._scaleSlot.source as AmountSource).getAmount() as Amount) * (MAX_FREQ - MIN_FREQ)
      : DEFAULT_FREQ

    this._speedAmt = this._speedSlot.isActive
      ? (this._speedSlot.source as AmountSource).getAmount() as Amount
      : this._speed
    this._evolveTime = elapsed * this._speedAmt * SPEED_SCALE

    this._detailEff = this._detailSlot.isActive
      ? (this._detailSlot.source as AmountSource).getAmount() as Amount
      : this._detail

    this._drift = this._driftSlot.isActive
      ? (this._driftSlot.source as DirectionSource).getDirection()
      : { angle: this._driftAngle, magnitude: MANUAL_DRIFT_MAGNITUDE }

    this._samplePos = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { x: 128, y: 128 }

    this._generateTexture()

    const type = NOISE_TYPES[this._noiseIndex]!
    if (type === 'static' || type === 'colour') {
      // Amount: current value of the grid cell under the sample position
      // (mean of the RGB channels for 'colour', the single R/grey channel
      // for 'static').
      const gx = Math.max(0, Math.min(this._staticGridSize - 1, Math.floor((this._samplePos.x / NOISE_SIZE) * this._staticGridSize)))
      const gy = Math.max(0, Math.min(this._staticGridSize - 1, Math.floor((this._samplePos.y / NOISE_SIZE) * this._staticGridSize)))
      const base = (gy * NOISE_SIZE + gx) * 3
      this._amountOut = type === 'colour'
        ? (this._staticGrid[base]! + this._staticGrid[base + 1]! + this._staticGrid[base + 2]!) / 3
        : this._staticGrid[base]!
    } else {
      // Amount: sample at normalised position
      const sx = (this._samplePos.x / NOISE_SIZE) * this._frequency
      const sy = (this._samplePos.y / NOISE_SIZE) * this._frequency
      this._amountOut = sampleNoise(
        type, sx, sy, this._seed,
        this._evolveTime, this._drift, this._detailEff, this._drops, this._frequency,
      )
    }
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    const r1 = this._row1()
    if (boundingBoxContains(r1.prev,  point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(r1.next,  point)) { this.cycleNext(); return true }
    if (boundingBoxContains(r1.label, point)) { this.cycleNext(); return true }
    if (boundingBoxContains(r1.seedDecr, point)) { this.decrSeed(); return true }
    if (boundingBoxContains(r1.seedIncr, point)) { this.incrSeed(); return true }

    const r2 = this._row2()
    if (boundingBoxContains(r2.speedDecr,  point)) { this.decrSpeed();  return true }
    if (boundingBoxContains(r2.speedIncr,  point)) { this.incrSpeed();  return true }
    if (boundingBoxContains(r2.detailDecr, point)) { this.decrDetail(); return true }
    if (boundingBoxContains(r2.detailIncr, point)) { this.incrDetail(); return true }
    if (boundingBoxContains(r2.driftDecr,  point)) { this.decrDrift();  return true }
    if (boundingBoxContains(r2.driftIncr,  point)) { this.incrDrift();  return true }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.canvasBounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit noise texture full-canvas at reduced opacity for overlay effect
    const cw = (ctx as CanvasRenderingContext2D).canvas?.width  ?? this._noiseCanvas.width
    const ch = (ctx as CanvasRenderingContext2D).canvas?.height ?? this._noiseCanvas.height
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.drawImage(this._noiseCanvas as CanvasImageSource, 0, 0, cw, ch)
    ctx.globalAlpha = 1
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return

    ctx.save()

    // Background pill spanning both rows
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 8)
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    this._renderRow1(ctx)
    this._renderRow2(ctx)

    ctx.restore()
  }

  private _renderRow1(ctx: Ctx2D): void {
    const { x, width } = this.canvasBounds
    const r1 = this._row1()

    this._drawNavBtn(ctx, r1.prev, '◀', r1.midY)

    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(r1.label.x, r1.label.y, r1.label.width, r1.label.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(NOISE_TYPES[this._noiseIndex]!, r1.label.x + r1.label.width / 2, r1.midY)

    this._drawNavBtn(ctx, r1.next, '▶', r1.midY)

    // Seed
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('seed', r1.seedLabelX, r1.midY)
    this._drawBtn(ctx, r1.seedDecr, '−', 'rgba(255,255,255,0.65)')
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.fillText(String(this._seed), r1.seedValueX + 10, r1.midY)
    this._drawBtn(ctx, r1.seedIncr, '+', 'rgba(255,255,255,0.65)')

    // Indicators
    this._drawIndicators(ctx, [
      { slot: this._timeSlot,     label: 'time'  },
      { slot: this._positionSlot, label: 'pos'   },
      { slot: this._scaleSlot,    label: 'scale' },
    ], x + width - 8, r1.midY)
  }

  private _renderRow2(ctx: Ctx2D): void {
    const { x, width } = this.canvasBounds
    const r2 = this._row2()

    // speed
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('speed', r2.speedLabelX, r2.midY)
    this._drawBtn(ctx, r2.speedDecr, '−', 'rgba(255,255,255,0.65)')
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    const speedVal = this._speedSlot.isActive
      ? ((this._speedSlot.source as AmountSource).getAmount() as Amount)
      : this._speed
    ctx.fillText(speedVal.toFixed(2), r2.speedValueX + 15, r2.midY)
    this._drawBtn(ctx, r2.speedIncr, '+', 'rgba(255,255,255,0.65)')

    // warp / detail
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'left'
    ctx.fillText('warp', r2.detailLabelX, r2.midY)
    this._drawBtn(ctx, r2.detailDecr, '−', 'rgba(255,255,255,0.65)')
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'center'
    const detailVal = this._detailSlot.isActive
      ? ((this._detailSlot.source as AmountSource).getAmount() as Amount)
      : this._detail
    ctx.fillText(detailVal.toFixed(2), r2.detailValueX + 15, r2.midY)
    this._drawBtn(ctx, r2.detailIncr, '+', 'rgba(255,255,255,0.65)')

    // drift
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'left'
    ctx.fillText('drift', r2.driftLabelX, r2.midY)
    this._drawNavBtn(ctx, r2.driftDecr, '‹', r2.midY)
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'center'
    let deg = Math.round(this._drift.angle * 180 / Math.PI)
    deg = ((deg % 360) + 360) % 360
    ctx.fillText(`${deg}°`, r2.driftValueX + 18, r2.midY)
    this._drawNavBtn(ctx, r2.driftIncr, '›', r2.midY)

    // Indicators
    this._drawIndicators(ctx, [
      { slot: this._speedSlot,  label: 'speed' },
      { slot: this._detailSlot, label: 'warp'  },
      { slot: this._driftSlot,  label: 'drift' },
    ], x + width - 8, r2.midY)
  }

  private _drawIndicators(ctx: Ctx2D, items: Array<{ slot: ParameterSlot; label: string }>, rightX: number, midY: number): void {
    let dx = rightX
    ctx.font         = '9px monospace'
    ctx.textBaseline = 'middle'
    for (let i = items.length - 1; i >= 0; i--) {
      const { slot, label } = items[i]!
      const active = slot.isActive
      ctx.fillStyle = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign = 'right'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 8
    }
  }

  // ----------------------------------------------------------
  // Texture generation
  // ----------------------------------------------------------

  private _generateTexture(): void {
    const type = NOISE_TYPES[this._noiseIndex]!

    if (type === 'static' || type === 'colour') {
      const colour = type === 'colour'
      this._ensureCanvasSize(NOISE_SIZE)
      this._updateStatic(colour)
      this._renderStatic(colour)
      return
    }

    if ((type === 'cracks' || type === 'warp' || type === 'organic' || type === 'ripples') && noiseGL.supported) {
      const ok = noiseGL.render(type as GLNoiseId, GL_NOISE_SIZE, {
        seed:       this._seed,
        t:          this._evolveTime,
        freq:       this._frequency,
        detail:     this._detailEff,
        driftAngle: this._drift.angle,
        driftMag:   this._drift.magnitude,
      })
      if (ok) {
        this._ensureCanvasSize(GL_NOISE_SIZE)
        this._noiseCanvas.getContext('2d')!.drawImage(noiseGL.canvas, 0, 0)
        return
      }
    }

    this._ensureCanvasSize(NOISE_SIZE)
    const size   = NOISE_SIZE
    const freq   = this._frequency
    const t      = this._evolveTime
    const seed   = this._seed
    const drift  = this._drift
    const detail = this._detailEff
    const drops  = this._drops
    const data   = new Uint8ClampedArray(size * size * 4)

    for (let py = 0; py < size; py++) {
      const ny = (py / size) * freq
      for (let px = 0; px < size; px++) {
        const nx = (px / size) * freq
        const v  = sampleNoise(type, nx, ny, seed, t, drift, detail, drops, freq)
        const c  = Math.round(Math.max(0, Math.min(1, v)) * 255)
        const i  = (py * size + px) * 4
        data[i] = data[i+1] = data[i+2] = c
        data[i+3] = 255
      }
    }

    const imgData = new ImageData(data, size, size)
    this._noiseCanvas.getContext('2d')!.putImageData(imgData, 0, 0)
  }

  // 'static'/'colour' — re-roll a random subset of grid cells. Grid size
  // tracks frequency (granularity); cell count re-rolled per frame tracks
  // speed. Math.random() is the cheapest available pseudo-random source and,
  // being a high-quality PRNG, produces no visible regularities at any grid
  // size. 'static' writes one shared value to all 3 channels of a cell;
  // 'colour' writes 3 independent values.
  private _updateStatic(colour: boolean): void {
    const gridSize = Math.max(1, Math.min(NOISE_SIZE, Math.round(this._frequency * STATIC_GRID_PER_FREQ)))
    this._staticGridSize = gridSize

    const numUpdates = Math.round(this._speedAmt * gridSize * gridSize * STATIC_UPDATE_FRACTION)
    for (let i = 0; i < numUpdates; i++) {
      const gx   = Math.floor(Math.random() * gridSize)
      const gy   = Math.floor(Math.random() * gridSize)
      const base = (gy * NOISE_SIZE + gx) * 3
      if (colour) {
        this._staticGrid[base]     = Math.random()
        this._staticGrid[base + 1] = Math.random()
        this._staticGrid[base + 2] = Math.random()
      } else {
        const v = Math.random()
        this._staticGrid[base] = this._staticGrid[base + 1] = this._staticGrid[base + 2] = v
      }
    }
  }

  // Blit the grid to the noise texture, scaling each cell up to fill its
  // share of the NOISE_SIZE × NOISE_SIZE canvas.
  private _renderStatic(colour: boolean): void {
    const size     = NOISE_SIZE
    const gridSize = this._staticGridSize
    const data     = new Uint8ClampedArray(size * size * 4)

    for (let py = 0; py < size; py++) {
      const gy = Math.min(gridSize - 1, Math.floor((py / size) * gridSize))
      for (let px = 0; px < size; px++) {
        const gx   = Math.min(gridSize - 1, Math.floor((px / size) * gridSize))
        const base = (gy * NOISE_SIZE + gx) * 3
        const i    = (py * size + px) * 4
        if (colour) {
          data[i]     = Math.round(this._staticGrid[base]!     * 255)
          data[i + 1] = Math.round(this._staticGrid[base + 1]! * 255)
          data[i + 2] = Math.round(this._staticGrid[base + 2]! * 255)
        } else {
          const c = Math.round(this._staticGrid[base]! * 255)
          data[i] = data[i+1] = data[i+2] = c
        }
        data[i+3] = 255
      }
    }

    const imgData = new ImageData(data, size, size)
    this._noiseCanvas.getContext('2d')!.putImageData(imgData, 0, 0)
  }

  // Resizing an OffscreenCanvas clears its content, but _generateTexture
  // redraws it every frame, so this is harmless.
  private _ensureCanvasSize(size: number): void {
    if (this._noiseCanvas.width !== size || this._noiseCanvas.height !== size) {
      this._noiseCanvas.width  = size
      this._noiseCanvas.height = size
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

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

  private _drawBtn(ctx: Ctx2D, b: BBox, label: string, colour: string): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 4)
    ctx.fill()
    ctx.font         = '13px monospace'
    ctx.fillStyle    = colour
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2)
  }

  // Row 1: [◀] type [▶]   seed [−] N [+]            time/pos/scale indicators
  private _row1() {
    const { x, y } = this.canvasBounds
    const ry   = y + PAD
    const midY = ry + ROW_H / 2
    const by   = ry + (ROW_H - BTN_H) / 2

    let cx = x + 8
    const prev = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 4
    const label = { x: cx, y: by, width: 56, height: BTN_H }
    cx += 56 + 4
    const next = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 14

    const seedLabelX = cx
    cx += 26
    const seedDecr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 2
    const seedValueX = cx
    cx += 20
    const seedIncr = { x: cx, y: by, width: BTN_W, height: BTN_H }

    return { y: ry, midY, prev, label, next, seedLabelX, seedDecr, seedValueX, seedIncr }
  }

  // Row 2: speed [−] N [+]   warp [−] N [+]   drift [‹] N° [›]   indicators
  private _row2() {
    const { x, y } = this.canvasBounds
    const ry   = y + PAD + ROW_H + ROW_GAP
    const midY = ry + ROW_H / 2
    const by   = ry + (ROW_H - BTN_H) / 2

    let cx = x + 8
    const speedLabelX = cx
    cx += 32
    const speedDecr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 2
    const speedValueX = cx
    cx += 30
    const speedIncr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 14

    const detailLabelX = cx
    cx += 30
    const detailDecr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 2
    const detailValueX = cx
    cx += 30
    const detailIncr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 14

    const driftLabelX = cx
    cx += 32
    const driftDecr = { x: cx, y: by, width: BTN_W, height: BTN_H }
    cx += BTN_W + 2
    const driftValueX = cx
    cx += 36
    const driftIncr = { x: cx, y: by, width: BTN_W, height: BTN_H }

    return {
      y: ry, midY,
      speedLabelX, speedDecr, speedValueX, speedIncr,
      detailLabelX, detailDecr, detailValueX, detailIncr,
      driftLabelX, driftDecr, driftValueX, driftIncr,
    }
  }
}
