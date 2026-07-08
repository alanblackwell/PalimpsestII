import { Layer } from '../core/Layer.js'
import { Node } from '../core/Node.js'
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
import { SliderSlot } from '../ui/SliderSlot.js'

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
//   │  opacity  [⏸ | ─────●────────────────────────────── | ⋯] │  ← SliderSlot
//   │  colour a [ ··· unbound / bound source ··············· ] │
//   │  colour b [ ··············································]│
//   │  position [ ··············································]│
//   │  direction[ ··············································]│
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

// Slot group layout — must match Layer.renderSlotGroup
const SLOT_H     = 30
const SLOT_GAP   = 4
const SL_LABEL_W = 78   // label column width (shared with slot rows)

const TYPE_COLOUR: Partial<Record<ValueType, string>> = {
  [ValueType.Amount]:    '#4a8fe8',
  [ValueType.Colour]:    '#e8944a',
  [ValueType.Point]:     '#cf7ecf',
  [ValueType.Direction]: '#7ecfcf',
}

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

  // Manual opacity, used while opacitySlot is unbound or suspended.
  private _opacity: number = 1   // [0, 1]

  // Combined slider + binding-slot widget for the opacity control.
  private readonly _opacityWidget: SliderSlot

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
    this._opacityWidget = new SliderSlot(
      this._opacitySlot, 'opacity', AM_COL,
      () => this._opacitySlot.isActive
            ? (this._opacitySlot.source as AmountSource).getAmount() as number
            : this._opacity,
      v => this.setOpacity(v),
      () => this.markDirty(),
    )
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
  get opacityWidget(): SliderSlot    { return this._opacityWidget  }

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
    if (this._opacityWidget.handlePointerDown(point, this._opacityRowBounds())) return true
    return false
  }

  handlePointerMove(point: Point): void {
    this._opacityWidget.handlePointerMove(point, this._opacityRowBounds())
  }

  handlePointerUp(): void {
    this._opacityWidget.handlePointerUp()
  }

  protected override hitTestSelf(point: { x: number; y: number }) {
    if (boundingBoxContains(this.canvasBounds, point)) return this
    if (boundingBoxContains(this._opacityRowBounds(), point)) return this
    return null
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

  // Bounds of the opacity SliderSlot row — first row of the combined pill.
  private _opacityRowBounds() {
    const cb = this.canvasBounds
    return { x: cb.x, y: this.panelBottom, width: cb.width, height: SLOT_H }
  }

  // Combined pill: SliderSlot (opacity) in row 0, standard slot rows below.
  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()

    const cb     = this.canvasBounds
    const px     = cb.x
    const pw     = cb.width
    const y0     = this.panelBottom
    // rows: 1 SliderSlot + 4 standard slots (colourA/B, position, direction)
    const n      = this.slots.length   // 5 total; opacity handled by widget
    const totalH = n * (SLOT_H + SLOT_GAP) - SLOT_GAP

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(px, y0, pw, totalH, 6)
    ctx.fill()
    ctx.restore()

    // Row 0: combined opacity slider + binding slot
    const opacityRow = this._opacityRowBounds()
    this._slotBounds.set(this._opacitySlot, opacityRow)  // full row = drop target
    this._opacityWidget.render(ctx, opacityRow)

    // Rows 1–4: standard slot rows (skipping opacitySlot, already handled above)
    let y = y0 + SLOT_H + SLOT_GAP
    for (const slot of this.slots) {
      if (slot === this._opacitySlot) continue
      this._renderSlotRow(ctx, slot, { x: px, y, width: pw, height: SLOT_H })
      y += SLOT_H + SLOT_GAP
    }
  }

  // Standard slot-binding row — replicates Layer.renderSlotGroup's per-row
  // rendering so the slot rows can be placed inside the combined slider pill.
  private _renderSlotRow(
    ctx: Ctx2D,
    slot: ParameterSlot,
    b: { x: number; y: number; width: number; height: number },
  ): void {
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
    const vx = b.x + SL_LABEL_W
    const vw = b.width - SL_LABEL_W - 2
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
}
