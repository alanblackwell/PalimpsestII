import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue, type ImageSource,
  type Amount,     type AmountSource,
  type Point,      type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

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
//   white   — hash per pixel; sharp, uncorrelated grain
//   value   — smoothstep-interpolated 2-D value noise
//   fbm2    — 2-octave fractional Brownian motion (value noise)
//   fbm4    — 4-octave fBm; richest detail
//
// All use a purely arithmetic hash (no look-up table) so they are
// fully deterministic given seed + input coordinates.
//
// Input slots:
//   timeSlot     (Amount) — slides the noise in the Z axis, animating
//                           the texture.  Wire to ClockLayer.
//   scaleSlot    (Amount) — maps [0, 1] → frequency [0.5, 16].
//                           Unbound default: 3.0.
//   positionSlot (Point)  — sample point used for the Amount output.
//                           Unbound default: canvas centre.
//
// Manual controls:
//   [◀] / [▶] — cycle noise type
//   seed [−][+] — integer seed (0 – 99), shifts the hash domain
//
// Visual layout (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] fbm4 [▶]   seed [−] 7 [+]    time ●  sc ○      │
//   └──────────────────────────────────────────────────────────┘
//
// The noise texture is rendered full-canvas below the panel; it
// fades to a semi-transparent overlay so underlying layers show
// through slightly.

// ------------------------------------------------------------------
// Noise implementation
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

type NoiseId = 'white' | 'value' | 'fbm2' | 'fbm4'
const NOISE_TYPES: NoiseId[] = ['white', 'value', 'fbm2', 'fbm4']

function sampleNoise(type: NoiseId, x: number, y: number, seed: number): number {
  switch (type) {
    case 'white': return hash2(x, y, seed)
    case 'value': return valueNoise(x, y, seed)
    case 'fbm2': {
      let v = 0, a = 0.5, f = 1
      for (let i = 0; i < 2; i++) { v += a * valueNoise(x*f, y*f, seed); a *= 0.5; f *= 2 }
      return v
    }
    case 'fbm4': {
      let v = 0, a = 0.5, f = 1
      for (let i = 0; i < 4; i++) { v += a * valueNoise(x*f, y*f, seed); a *= 0.5; f *= 2 }
      return v
    }
  }
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT     = '#b8a050'   // warm amber — noise / procedural
const NOISE_SIZE = 256         // internal noise texture resolution
const BTN_W      = 18
const BTN_H      = 22
const LABEL_W    = 46
const BTN        = 18
const BTN_M      = 6
const DEFAULT_FREQ = 3.0
const MIN_FREQ   = 0.5
const MAX_FREQ   = 16.0

// ------------------------------------------------------------------
// NoiseLayer
// ------------------------------------------------------------------

export class NoiseLayer extends Layer implements AmountSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Amount, ValueType.Image])

  private readonly _timeSlot:     ParameterSlot
  private readonly _scaleSlot:    ParameterSlot
  private readonly _positionSlot: ParameterSlot

  private _noiseIndex: number = 3       // default: fbm4
  private _seed:       number = 0
  private _amountOut:  number = 0

  // 256×256 noise texture (returned as ImageValue)
  private _noiseCanvas: OffscreenCanvas

  // Resolved slot values
  private _timeValue: number = 0
  private _frequency: number = DEFAULT_FREQ
  private _samplePos: Point  = { x: 128, y: 128 }

  constructor() {
    super()
    this._noiseCanvas   = new OffscreenCanvas(NOISE_SIZE, NOISE_SIZE)
    this._timeSlot      = new ParameterSlot(ValueType.Amount, this)
    this._scaleSlot     = new ParameterSlot(ValueType.Amount, this)
    this._positionSlot  = new ParameterSlot(ValueType.Point,  this)
    this.slots.push(this._timeSlot, this._scaleSlot, this._positionSlot)
    this.debugName = 'NoiseLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Sources
  // ----------------------------------------------------------

  getAmount(): Amount     { return this._amountOut   }
  getImage():  ImageValue { return this._noiseCanvas }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get timeSlot():     ParameterSlot { return this._timeSlot     }
  get scaleSlot():    ParameterSlot { return this._scaleSlot    }
  get positionSlot(): ParameterSlot { return this._positionSlot }

  // ----------------------------------------------------------
  // Cycling / seed
  // ----------------------------------------------------------

  cycleNext(): void { this._noiseIndex = (this._noiseIndex + 1) % NOISE_TYPES.length; this.markDirty() }
  cyclePrev(): void { this._noiseIndex = (this._noiseIndex - 1 + NOISE_TYPES.length) % NOISE_TYPES.length; this.markDirty() }
  incrSeed():  void { this._seed = (this._seed + 1) % 100; this.markDirty() }
  decrSeed():  void { this._seed = (this._seed - 1 + 100) % 100; this.markDirty() }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    this._timeValue = this._timeSlot.isActive
      ? (this._timeSlot.source as AmountSource).getAmount() as Amount
      : 0

    this._frequency = this._scaleSlot.isActive
      ? MIN_FREQ + (this._scaleSlot.source as AmountSource).getAmount() as Amount * (MAX_FREQ - MIN_FREQ)
      : DEFAULT_FREQ

    this._samplePos = this._positionSlot.isActive
      ? (this._positionSlot.source as PointSource).getPoint()
      : { x: 128, y: 128 }

    this._generateTexture()

    // Amount: sample at normalised position
    const sx = (this._samplePos.x / NOISE_SIZE) * this._frequency
    const sy = (this._samplePos.y / NOISE_SIZE) * this._frequency + this._timeValue * 0.5
    this._amountOut = sampleNoise(NOISE_TYPES[this._noiseIndex], sx, sy, this._seed)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._labelBounds(),   point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._decrSeedBounds(), point)) { this.decrSeed(); return true }
    if (boundingBoxContains(this._incrSeedBounds(), point)) { this.incrSeed(); return true }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
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
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // [◀] noise type label [▶]
    this._drawNavBtn(ctx, this._prevBtnBounds(), '◀', midY)

    const lb = this._labelBounds()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.roundRect(lb.x, lb.y, lb.width, lb.height, 3)
    ctx.fill()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(NOISE_TYPES[this._noiseIndex], lb.x + lb.width / 2, midY)

    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // Seed section
    const db = this._decrSeedBounds()
    const ib = this._incrSeedBounds()
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('seed', db.x - 2 - ctx.measureText('seed').width, midY)

    this._drawBtn(ctx, db, '−', 'rgba(255,255,255,0.65)')
    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.90)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(this._seed), (db.x + db.width + ib.x) / 2, midY)
    this._drawBtn(ctx, ib, '+', 'rgba(255,255,255,0.65)')

    // Slot indicators (right side)
    const slots = [
      { slot: this._timeSlot,     label: 'time' },
      { slot: this._scaleSlot,    label: 'sc'   },
      { slot: this._positionSlot, label: 'pos'  },
    ]
    let dx = x + width - BTN_M
    ctx.font = '9px monospace'
    for (let i = slots.length - 1; i >= 0; i--) {
      const { slot, label } = slots[i]
      const active = slot.isActive
      ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.22)'
      ctx.textAlign    = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText(active ? '●' : '○', dx, midY)
      dx -= 12
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText(label, dx, midY)
      dx -= ctx.measureText(label).width + 6
    }

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Texture generation
  // ----------------------------------------------------------

  private _generateTexture(): void {
    const size  = NOISE_SIZE
    const type  = NOISE_TYPES[this._noiseIndex]
    const freq  = this._frequency
    const t     = this._timeValue
    const seed  = this._seed
    const data  = new Uint8ClampedArray(size * size * 4)

    for (let py = 0; py < size; py++) {
      const ny = (py / size) * freq + t * 0.5
      for (let px = 0; px < size; px++) {
        const nx = (px / size) * freq
        const v  = sampleNoise(type, nx, ny, seed)
        const c  = Math.round(Math.max(0, Math.min(1, v)) * 255)
        const i  = (py * size + px) * 4
        data[i] = data[i+1] = data[i+2] = c
        data[i+3] = 255
      }
    }

    const imgData = new ImageData(data, size, size)
    this._noiseCanvas.getContext('2d')!.putImageData(imgData, 0, 0)
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private _drawNavBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    midY: number,
  ): void {
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

  private _drawBtn(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    label: string,
    colour: string,
  ): void {
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

  // Button / zone geometry

  private _prevBtnBounds() {
    const { x, y, height } = this.bounds
    return { x: x + 8, y: y + (height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _labelBounds() {
    const pb = this._prevBtnBounds()
    return { x: pb.x + BTN_W + 4, y: pb.y, width: LABEL_W, height: BTN_H }
  }

  private _nextBtnBounds() {
    const lb = this._labelBounds()
    return { x: lb.x + LABEL_W + 4, y: lb.y, width: BTN_W, height: BTN_H }
  }

  private _decrSeedBounds() {
    const nb = this._nextBtnBounds()
    return { x: nb.x + BTN_W + 28, y: nb.y, width: BTN, height: BTN_H }
  }

  private _incrSeedBounds() {
    const db = this._decrSeedBounds()
    return { x: db.x + BTN + 18, y: db.y, width: BTN, height: BTN_H }
  }
}
