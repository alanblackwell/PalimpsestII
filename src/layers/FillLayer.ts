import { Layer } from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  boundingBoxContains,
  type ImageValue,    type ImageSource,
  type Colour,        type ColourSource,
  type Point,         type PointSource,
  type Direction,     type DirectionSource,
  type Amount,        type AmountSource,
  type Ctx2D,
} from '../core/types.js'
import { graph } from '../dataflow/Graph.js'
import { BindingLayer } from './BindingLayer.js'

// ------------------------------------------------------------
// FillLayer — procedural fill / gradient image generator
// ------------------------------------------------------------
//
// Renders a flat fill or two-stop gradient into a full-canvas
// OffscreenCanvas and exposes it as an ImageSource. Three modes:
//
//   fill   — (default) the whole canvas filled with colourA.
//
//   linear — angle from directionSlot (or 0° = left→right).
//            The gradient spans the canvas diagonal at the given
//            angle, centred on positionSlot.
//
//   radial — concentric circles centred on positionSlot.
//            Radius = direction.magnitude × half canvas diagonal.
//
// Input slots:
//   colourASlot   (Colour)    — start / inner colour (fill: the
//                              colour). Unbound default: black.
//   colourBSlot   (Colour)    — end / outer colour. Unbound default:
//                              white.
//   positionSlot  (Point)     — gradient centre / origin.
//                              Unbound default: canvas centre.
//   directionSlot (Direction) — angle controls gradient axis;
//                              magnitude controls reach for radial.
//                              Unbound defaults: angle=0, magnitude=0.5.
//   opacitySlot   (Amount)    — overall opacity multiplier, applied to
//                              the whole result. Manual slider, [0,1],
//                              default 1 (fully opaque).
//
// linear/radial: if exactly one of colourA/colourB is bound, the
// gradient uses just that colour, ranging from opaque (at that
// colour's own stop) to fully transparent at the other stop — instead
// of mixing in the unbound side's default colour.
//
// Visual layout:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  [◀] linear [▶]   colA ●  colB ●  pos ●  dir ○        │
//   └──────────────────────────────────────────────────────────┘
//   ┌──────────────────────────────────────────────────────────┐
//   │ ▌  opacity  ──────────●────────────────────  0.80    ○   │
//   └──────────────────────────────────────────────────────────┘
//
// Call resize(w, h) when the canvas dimensions change.

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT   = '#c890e8'   // lavender — distinct, fits "gradient/colour"
const AM_COL   = '#4a8fe8'   // Amount type accent (opacity slot)
const BTN_W    = 18
const BTN_H    = 22
const LABEL_W  = 52
const BTN_M    = 6
const SWAP_W   = 18   // swap-colours button, between the two swatches

const OPACITY_H = 36   // separate pill below the main controls
const OP_LABEL_W = 50
const OP_VALUE_W = 40

type GradType = 'fill' | 'linear' | 'radial'
const GRAD_TYPES: GradType[] = ['fill', 'linear', 'radial']

const DEFAULT_COL_A: Colour = { r: 0,   g: 0,   b: 0,   a: 1 }
const DEFAULT_COL_B: Colour = { r: 1,   g: 1,   b: 1,   a: 1 }
const DEFAULT_DIR:   Direction = { angle: 0, magnitude: 0.5 }

// Swatch colour shown for an unbound colour slot — transparent rather than
// the black/white fallback used for the actual fill/gradient defaults.
const TRANSPARENT: Colour = { r: 0, g: 0, b: 0, a: 0 }

// ------------------------------------------------------------------
// Helper
// ------------------------------------------------------------------

function colCss(c: Colour): string {
  return `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a.toFixed(3)})`
}

// ------------------------------------------------------------------
// FillLayer
// ------------------------------------------------------------------

export class FillLayer extends Layer implements ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Image])

  private readonly _colourASlot:   ParameterSlot
  private readonly _colourBSlot:   ParameterSlot
  private readonly _positionSlot:  ParameterSlot
  private readonly _directionSlot: ParameterSlot
  private readonly _opacitySlot:   ParameterSlot

  private _gradIndex: number = 0   // default: fill
  private _offscreen:  OffscreenCanvas

  // Manual opacity, used while opacitySlot is unbound.
  private _opacity: number = 1   // [0, 1]
  private _opacityDrag = false

  constructor(canvasWidth = 1920, canvasHeight = 1080) {
    super()
    this._offscreen     = new OffscreenCanvas(canvasWidth, canvasHeight)
    this._colourASlot   = new ParameterSlot(ValueType.Colour,    this, 'colour a')
    this._colourBSlot   = new ParameterSlot(ValueType.Colour,    this, 'colour b')
    this._positionSlot  = new ParameterSlot(ValueType.Point,     this)
    this._directionSlot = new ParameterSlot(ValueType.Direction, this)
    this._opacitySlot   = new ParameterSlot(ValueType.Amount,    this, 'opacity')
    this.slots.push(this._colourASlot, this._colourBSlot,
                    this._positionSlot, this._directionSlot, this._opacitySlot)
    this.debugName = 'FillLayer'
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
  get opacitySlot():   ParameterSlot { return this._opacitySlot   }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this._opacitySlot) return this._opacity
    return null
  }

  // ----------------------------------------------------------
  // Type cycling
  // ----------------------------------------------------------

  cycleNext(): void { this._gradIndex = (this._gradIndex + 1) % GRAD_TYPES.length; this.markDirty() }
  cyclePrev(): void { this._gradIndex = (this._gradIndex - 1 + GRAD_TYPES.length) % GRAD_TYPES.length; this.markDirty() }

  // Swap the source layers bound to colourASlot and colourBSlot (any
  // combination of bound/unbound is handled).
  private _swapColours(): void {
    const aBL = BindingLayer.findForSlot(this._colourASlot)
    const bBL = BindingLayer.findForSlot(this._colourBSlot)
    const aSource = aBL?.source ?? null
    const bSource = bBL?.source ?? null

    aBL?.remove()
    bBL?.remove()

    if (bSource !== null) BindingLayer.create(bSource, this._colourASlot)
    if (aSource !== null) BindingLayer.create(aSource, this._colourBSlot)
  }

  // ----------------------------------------------------------
  // Opacity
  // ----------------------------------------------------------

  // Touching the slider while opacitySlot is bound suspends the binding
  // first, handing control back to the user at the current value (same
  // pattern as AmountLayer/NoiseLayer's slider overrides).
  setOpacity(v: number): void {
    if (this._opacitySlot.state === SlotState.Bound) BindingLayer.findForSlot(this._opacitySlot)?.toggle()
    this._opacity = Math.max(0, Math.min(1, v))
    this.markDirty()
  }

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

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { gradIndex: this._gradIndex, opacity: this._opacity }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.gradIndex === 'number') this._gradIndex = state.gradIndex
    if (typeof state.opacity === 'number')   this._opacity   = state.opacity
  }

  protected recompute(): void {
    const w = this._offscreen.width
    const h = this._offscreen.height

    const aActive = this._colourASlot.isActive
    const bActive = this._colourBSlot.isActive

    const colA = aActive
      ? (this._colourASlot.source   as ColourSource).getColour()
      : DEFAULT_COL_A
    const colB = bActive
      ? (this._colourBSlot.source   as ColourSource).getColour()
      : DEFAULT_COL_B
    const pos  = this._positionSlot.isActive
      ? (this._positionSlot.source  as PointSource).getPoint()
      : { x: w / 2, y: h / 2 }
    const dir  = this._directionSlot.isActive
      ? (this._directionSlot.source as DirectionSource).getDirection()
      : DEFAULT_DIR
    const opacity = this._opacitySlot.isActive
      ? (this._opacitySlot.source   as AmountSource).getAmount() as Amount
      : this._opacity

    this._draw(colA, colB, aActive, bActive, pos, dir, opacity, w, h)
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (boundingBoxContains(this._prevBtnBounds(), point)) { this.cyclePrev(); return true }
    if (boundingBoxContains(this._nextBtnBounds(), point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._labelBounds(),   point)) { this.cycleNext(); return true }
    if (boundingBoxContains(this._swapBtnBounds(), point)) { this._swapColours(); return true }

    const g = this._opacitySliderGeom()
    if (point.x >= g.sld0 - 6 && point.x <= g.sldR + 6 &&
        point.y >= g.b.y    && point.y <= g.b.y + g.b.height) {
      this._opacityDrag = true
      this._setOpacityFromPointer(point.x)
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (!this._opacityDrag) return
    this._setOpacityFromPointer(point.x)
  }

  handlePointerUp(): void {
    this._opacityDrag = false
  }

  private _setOpacityFromPointer(px: number): void {
    const g      = this._opacitySliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this.setOpacity((px - lo) / range)
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._opacityPillBounds(), point)) return this
    return null
  }

  // Slot rows are drawn below the opacity pill, not directly below the
  // main controls pill.
  override get panelBottom(): number {
    const ob = this._opacityPillBounds()
    return ob.y + ob.height + 8
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // Blit fill/gradient to main canvas
    ctx.save()
    ctx.drawImage(this._offscreen as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  // ── Stack panel ─────────────────────────────────────────────

  renderPanel(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
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

    // ColourA swatch — transparent when unbound
    const aB = this._colourASwatchBounds()
    this._drawSwatch(ctx, aB, this._colourASlot.isActive
      ? (this._colourASlot.source as ColourSource).getColour()
      : TRANSPARENT, this._colourASlot.isActive)

    // Swap button
    this._drawNavBtn(ctx, this._swapBtnBounds(), '⇄', midY)

    // ColourB swatch — transparent when unbound
    const bB = this._colourBSwatchBounds()
    this._drawSwatch(ctx, bB, this._colourBSlot.isActive
      ? (this._colourBSlot.source as ColourSource).getColour()
      : TRANSPARENT, this._colourBSlot.isActive)

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

    this._drawOpacityPill(ctx)
  }

  private _drawOpacityPill(ctx: Ctx2D): void {
    const g = this._opacitySliderGeom()
    const { x, y, width, height } = g.b

    const active = this._opacitySlot.isActive
    const value  = active
      ? (this._opacitySlot.source as AmountSource).getAmount() as Amount
      : this._opacity
    const colour = active ? AM_COL : ACCENT

    ctx.save()

    // Background pill
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Label
    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.50)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('opacity', g.labelX, g.midY)

    // Slider
    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, value, colour)

    // Value text
    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(value.toFixed(2), g.valueRight, g.midY)

    // Bind indicator
    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

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

  // ----------------------------------------------------------
  // Fill / gradient drawing
  // ----------------------------------------------------------

  private _draw(
    colA: Colour, colB: Colour, aActive: boolean, bActive: boolean,
    pos: Point, dir: Direction, opacity: number,
    w: number, h: number,
  ): void {
    const ctx  = this._offscreen.getContext('2d')! as CanvasRenderingContext2D
    const type = GRAD_TYPES[this._gradIndex]

    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity))

    if (type === 'fill') {
      ctx.fillStyle = colCss(colA)
      ctx.fillRect(0, 0, w, h)
      ctx.restore()
      return
    }

    const [stopA, stopB] = this._resolveStops(colA, colB, aActive, bActive)
    const cssA = colCss(stopA)
    const cssB = colCss(stopB)

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

    } else {
      // radial
      const diag  = Math.sqrt(w * w + h * h)
      const r     = Math.max(1, dir.magnitude * diag)
      grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, r)
    }

    grad.addColorStop(0, cssA)
    grad.addColorStop(1, cssB)

    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  }

  // If both colours are bound, use them as-is. If only one is bound, use
  // that colour at both stops — opaque at its own end, transparent at the
  // other. If neither is bound, fall back to the black→white defaults.
  private _resolveStops(colA: Colour, colB: Colour, aActive: boolean, bActive: boolean): [Colour, Colour] {
    if (aActive && bActive) return [colA, colB]
    if (aActive) return [colA, { ...colA, a: 0 }]
    if (bActive) return [{ ...colB, a: 0 }, colB]
    return [DEFAULT_COL_A, DEFAULT_COL_B]
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
    const { x, y, height } = this.canvasBounds
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

  private _swapBtnBounds() {
    const ab = this._colourASwatchBounds()
    return { x: ab.x + ab.width + 4, y: ab.y, width: SWAP_W, height: ab.height }
  }

  private _colourBSwatchBounds() {
    const sb = this._swapBtnBounds()
    return { x: sb.x + sb.width + 4, y: sb.y, width: 22, height: sb.height }
  }

  // Opacity pill — directly below the main controls pill.
  private _opacityPillBounds() {
    const cb = this.canvasBounds
    return { x: cb.x, y: cb.y + cb.height + 8, width: cb.width, height: OPACITY_H }
  }

  private _opacitySliderGeom() {
    const b      = this._opacityPillBounds()
    const midY   = b.y + b.height / 2
    const labelX = b.x + 12
    const indX   = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0   = labelX + OP_LABEL_W
    const sldR   = valueRight - OP_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }
}
