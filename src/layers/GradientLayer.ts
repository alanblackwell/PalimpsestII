import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type ImageValue,    type ImageSource,
  type Colour,        type ColourSource,
  type Point,         type PointSource,
  type Direction,     type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'

// ------------------------------------------------------------
// GradientLayer — procedural gradient image generator
// ------------------------------------------------------------
//
// Renders a two-stop gradient into a full-canvas OffscreenCanvas
// and exposes it as an ImageSource.  Three gradient types:
//
//   linear — angle from directionSlot (or 0° = left→right).
//            The gradient spans the canvas diagonal at the given
//            angle, centred on positionSlot.
//
//   radial — concentric circles centred on positionSlot.
//            Radius = direction.magnitude × half canvas diagonal.
//
//   conic  — sweeps 360° around positionSlot, starting at
//            direction.angle.
//
// Input slots:
//   colourASlot   (Colour)    — start / inner / start-angle colour.
//                              Unbound default: black.
//   colourBSlot   (Colour)    — end / outer / end-angle colour.
//                              Unbound default: white.
//   positionSlot  (Point)     — gradient centre / origin.
//                              Unbound default: canvas centre.
//   directionSlot (Direction) — angle controls gradient axis / start
//                              angle; magnitude controls reach for
//                              radial.  Unbound defaults: angle=0,
//                              magnitude=0.5.
//
// Visual layout (height ≈ 36 px):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] radial [▶]   colA ●  colB ●  pos ●  dir ○       │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT   = '#c890e8'   // lavender — distinct, fits "gradient/colour"
const BTN_W    = 18
const BTN_H    = 22
const LABEL_W  = 52
const BTN_M    = 6

type GradType = 'linear' | 'radial' | 'conic'
const GRAD_TYPES: GradType[] = ['linear', 'radial', 'conic']

const DEFAULT_COL_A: Colour = { r: 0,   g: 0,   b: 0,   a: 1 }
const DEFAULT_COL_B: Colour = { r: 1,   g: 1,   b: 1,   a: 1 }
const DEFAULT_DIR:   Direction = { angle: 0, magnitude: 0.5 }

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------

function colCss(c: Colour): string {
  return `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a.toFixed(3)})`
}

// ------------------------------------------------------------------
// GradientLayer
// ------------------------------------------------------------------

export class GradientLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _colourASlot:   ParameterSlot
  private readonly _colourBSlot:   ParameterSlot
  private readonly _positionSlot:  ParameterSlot
  private readonly _directionSlot: ParameterSlot

  private _gradIndex: number = 0   // default: linear
  private _offscreen:  OffscreenCanvas

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen     = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._colourASlot   = new ParameterSlot(ValueType.Colour,    this)
    this._colourBSlot   = new ParameterSlot(ValueType.Colour,    this)
    this._positionSlot  = new ParameterSlot(ValueType.Point,     this)
    this._directionSlot = new ParameterSlot(ValueType.Direction, this)
    this.slots.push(this._colourASlot, this._colourBSlot,
                    this._positionSlot, this._directionSlot)
    this.debugName = 'GradientLayer'
    graph.register(this)
  }

  // ----------------------------------------------------------
  // ImageSource
  // ----------------------------------------------------------

  getImage(): ImageValue { return this._offscreen }

  // ----------------------------------------------------------
  // Slot accessors
  // ----------------------------------------------------------

  get colourASlot():   ParameterSlot { return this._colourASlot   }
  get colourBSlot():   ParameterSlot { return this._colourBSlot   }
  get positionSlot():  ParameterSlot { return this._positionSlot  }
  get directionSlot(): ParameterSlot { return this._directionSlot }

  // ----------------------------------------------------------
  // Type cycling
  // ----------------------------------------------------------

  cycleNext(): void { this._gradIndex = (this._gradIndex + 1) % GRAD_TYPES.length; this.markDirty() }
  cyclePrev(): void { this._gradIndex = (this._gradIndex - 1 + GRAD_TYPES.length) % GRAD_TYPES.length; this.markDirty() }

  // ----------------------------------------------------------
  // Resize
  // ----------------------------------------------------------

  resize(w: number, h: number): void {
    this._offscreen = new OffscreenCanvas(w, h)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    const w = this._offscreen.width
    const h = this._offscreen.height

    const colA = this._colourASlot.isActive
      ? (this._colourASlot.source   as ColourSource).getColour()
      : DEFAULT_COL_A
    const colB = this._colourBSlot.isActive
      ? (this._colourBSlot.source   as ColourSource).getColour()
      : DEFAULT_COL_B
    const pos  = this._positionSlot.isActive
      ? (this._positionSlot.source  as PointSource).getPoint()
      : { x: w / 2, y: h / 2 }
    const dir  = this._directionSlot.isActive
      ? (this._directionSlot.source as DirectionSource).getDirection()
      : DEFAULT_DIR

    this._drawGradient(colA, colB, pos, dir, w, h)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._labelBounds(),   point)) { this.cycleNext(); return true }
    return false
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    return boundingBoxContains(this.bounds, point) ? this : null
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit gradient to main canvas
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
    ctx.restore()

    this._renderPanel(ctx)
  }

  // ── Stack panel ─────────────────────────────────────────────

  private _renderPanel(ctx: Ctx2D): void {
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

    // [◀] type label [▶]
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
    ctx.fillText(GRAD_TYPES[this._gradIndex], lb.x + lb.width / 2, midY)

    this._drawNavBtn(ctx, this._nextBtnBounds(), '▶', midY)

    // ColourA swatch
    const aB = this._colourASwatchBounds()
    this._drawSwatch(ctx, aB, this._colourASlot.isActive
      ? (this._colourASlot.source as ColourSource).getColour()
      : DEFAULT_COL_A, this._colourASlot.isActive)

    // ColourB swatch
    const bB = this._colourBSwatchBounds()
    this._drawSwatch(ctx, bB, this._colourBSlot.isActive
      ? (this._colourBSlot.source as ColourSource).getColour()
      : DEFAULT_COL_B, this._colourBSlot.isActive)

    // Slot indicators — pos / dir
    const slots = [
      { slot: this._positionSlot,  label: 'pos' },
      { slot: this._directionSlot, label: 'dir' },
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
  // Gradient drawing
  // ----------------------------------------------------------

  private _drawGradient(
    colA: Colour, colB: Colour,
    pos: Point, dir: Direction,
    w: number, h: number,
  ): void {
    const ctx  = this._offscreen.getContext('2d')! as CanvasRenderingContext2D
    const cssA = colCss(colA)
    const cssB = colCss(colB)
    const type = GRAD_TYPES[this._gradIndex]

    ctx.clearRect(0, 0, w, h)

    let grad: CanvasGradient

    if (type === 'linear') {
      // Span the canvas diagonal at `dir.angle`, centred on `pos`
      const diag  = Math.sqrt(w * w + h * h) * dir.magnitude
      const cos   = Math.cos(dir.angle)
      const sin   = Math.sin(dir.angle)
      const x1    = pos.x - cos * diag
      const y1    = pos.y - sin * diag
      const x2    = pos.x + cos * diag
      const y2    = pos.y + sin * diag
      grad = ctx.createLinearGradient(x1, y1, x2, y2)

    } else if (type === 'radial') {
      const diag  = Math.sqrt(w * w + h * h)
      const r     = Math.max(1, dir.magnitude * diag)
      grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r)

    } else {
      // conic — createConicGradient(startAngle, cx, cy)
      grad = (ctx as unknown as { createConicGradient(a: number, x: number, y: number): CanvasGradient })
               .createConicGradient(dir.angle, pos.x, pos.y)
    }

    grad.addColorStop(0, cssA)
    grad.addColorStop(1, cssB)

    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
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

  private _drawSwatch(
    ctx: Ctx2D,
    b: { x: number; y: number; width: number; height: number },
    colour: Colour,
    bound: boolean,
  ): void {
    const css = colCss(colour)
    ctx.fillStyle = css
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.strokeStyle = bound ? ACCENT : 'rgba(255,255,255,0.20)'
    ctx.lineWidth   = 1
    ctx.stroke()
  }

  // Button / swatch geometry

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

  private _colourASwatchBounds() {
    const nb = this._nextBtnBounds()
    return { x: nb.x + BTN_W + 8, y: nb.y + 1, width: 22, height: BTN_H - 2 }
  }

  private _colourBSwatchBounds() {
    const ab = this._colourASwatchBounds()
    return { x: ab.x + 26, y: ab.y, width: 22, height: ab.height }
  }
}
