import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Colour, type ColourSource,
  type AmountSource,
  type Point,  type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ------------------------------------------------------------
// LineLayer — a straight line with configurable endpoints,
// stroke width, colour, and optional arrowheads.
// ------------------------------------------------------------
//
// Controls:
//   Start/end drag handles — drag to reposition each endpoint.
//     Dragging a handle while its slot is Bound suspends the
//     binding (suspend-on-touch).
//   Width slider — manual [0,1] maps to [0.5, 30] px. Dragging
//     the slider while widthSlot is Bound suspends it first.
//   Arrow toggles (◀ / ▶) — toggle arrowheads at the start or
//     end of the line. Arrowhead shape adapts to stroke width:
//     narrow strokes → long, acute head; wide strokes → right-angle
//     head with sides extending at least 5px beyond the stroke edge.
//
// All line content (body + arrowheads) is rendered to an OffscreenCanvas
// then composited to the main canvas with a single drawImage call. This
// ensures the drop-shadow applied by the Evaluator in edit mode is computed
// from the composite shape rather than from each element separately.
//
// Slots: start (Point), end (Point), width (Amount), colour (Colour).

const ACCENT      = '#e87e7e'    // Line layer accent colour
const AM_COL      = '#4a8fe8'    // Amount type accent (width slot)
const HANDLE_R    = 7            // handle circle radius (px)
const HANDLE_HIT  = 14           // pointer hit radius for handles (px)
const MAX_STROKE_W = 30          // Amount [0,1] → width [0.5, 30] px
const INIT_MARGIN = 0.15         // fraction of canvas kept clear on random init
// Minimum extension of arrowhead wing beyond the stroke edge (px each side).
const ARROW_MIN_EXTEND = 5

const SLOT_H      = 26
const SLOT_GAP    = 4
const SW_LABEL_W  = 78
const SW_VALUE_W  = 38

type BBox = { x: number; y: number; width: number; height: number }
type HandleDrag = 'start' | 'end'

function ptDist(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y) }

export class LineLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  readonly startSlot:  ParameterSlot
  readonly endSlot:    ParameterSlot
  readonly widthSlot:  ParameterSlot
  readonly colourSlot: ParameterSlot

  private _start: Point
  private _end:   Point
  private _strokeWidth = 3
  private _colour: Colour = { r: 0.5, g: 0.5, b: 0.5, a: 1 }  // mid grey default
  private _arrowStart = false
  private _arrowEnd   = false

  // Offscreen canvas — all line elements composited here, then drawn once
  // to the main canvas so the edit-mode drop-shadow covers the whole shape.
  private _canvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  // Active drag
  private _drag:           HandleDrag | null = null
  private _dragStartMouse: Point | null      = null
  private _dragStartPt:    Point | null      = null
  private _sliderDrag = false

  // Button bounds written in renderPanel, read in hitTestSelf
  private _arrowStartBounds: BBox | null = null
  private _arrowEndBounds:   BBox | null = null

  constructor() {
    super()
    const W = Node.canvasWidth
    const H = Node.canvasHeight
    const m = INIT_MARGIN
    this._start = {
      x: (m + Math.random() * (1 - 2 * m)) * W,
      y: (m + Math.random() * (1 - 2 * m)) * H,
    }
    this._end = {
      x: (m + Math.random() * (1 - 2 * m)) * W,
      y: (m + Math.random() * (1 - 2 * m)) * H,
    }

    this.startSlot  = new ParameterSlot(ValueType.Point,  this, 'start')
    this.endSlot    = new ParameterSlot(ValueType.Point,  this, 'end')
    this.widthSlot  = new ParameterSlot(ValueType.Amount, this, 'width')
    this.colourSlot = new ParameterSlot(ValueType.Colour, this, 'colour')
    this.slots.push(this.startSlot, this.endSlot, this.widthSlot, this.colourSlot)
    graph.register(this)
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      start:       this._start,
      end:         this._end,
      strokeWidth: this._strokeWidth,
      colour:      this._colour,
      arrowStart:  this._arrowStart,
      arrowEnd:    this._arrowEnd,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (state.start && typeof state.start === 'object')   this._start = state.start as Point
    if (state.end   && typeof state.end   === 'object')   this._end   = state.end   as Point
    if (typeof state.strokeWidth === 'number')            this._strokeWidth = state.strokeWidth
    if (state.colour && typeof state.colour === 'object') this._colour = state.colour as Colour
    if (typeof state.arrowStart === 'boolean')            this._arrowStart = state.arrowStart
    if (typeof state.arrowEnd   === 'boolean')            this._arrowEnd   = state.arrowEnd
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | null {
    if (slot === this.startSlot) return { ...this._start }
    if (slot === this.endSlot)   return { ...this._end   }
    if (slot === this.widthSlot) return Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_W))
    return null
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.startSlot.isActive)  this._start = (this.startSlot.source  as PointSource).getPoint()
    if (this.endSlot.isActive)    this._end   = (this.endSlot.source    as PointSource).getPoint()
    if (this.widthSlot.isActive)  this._strokeWidth = Math.max(0.5, (this.widthSlot.source as AmountSource).getAmount() * MAX_STROKE_W)
    if (this.colourSlot.isActive) this._colour = (this.colourSlot.source as ColourSource).getColour()
    this._updateCanvas()
  }

  // ----------------------------------------------------------
  // Arrowhead geometry
  // ----------------------------------------------------------

  // Half-angle: 15° (narrow, acute) → 45° (wide, right-angle at tip).
  // Half-width: at least ARROW_MIN_EXTEND beyond the stroke edge on each side.
  private _arrowGeom(): { hw: number; len: number } {
    const w   = this._strokeWidth
    const t   = Math.max(0, Math.min(1, w / MAX_STROKE_W))
    const ang = (15 + t * 30) * (Math.PI / 180)
    const hw  = w / 2 + ARROW_MIN_EXTEND
    return { hw, len: hw / Math.tan(ang) }
  }

  // ----------------------------------------------------------
  // Offscreen canvas — renders the complete line shape once
  // ----------------------------------------------------------

  private _updateCanvas(): void {
    const cw = Node.canvasWidth, ch = Node.canvasHeight
    if (this._canvas.width !== cw || this._canvas.height !== ch) {
      this._canvas = new OffscreenCanvas(cw, ch)
    }
    const ctx = this._canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return
    ctx.clearRect(0, 0, cw, ch)
    this._drawLineContent(ctx)
  }

  private _drawLineContent(ctx: OffscreenCanvasRenderingContext2D): void {
    const dx  = this._end.x - this._start.x
    const dy  = this._end.y - this._start.y
    const len = Math.hypot(dx, dy)
    if (len < 0.5) return

    const udx = dx / len, udy = dy / len        // unit axis A→B
    const nx  = -udy, ny  = udx                 // left-hand perp unit vector
    const w   = this._strokeWidth
    const r   = w / 2
    const { hw, len: aLen } = this._arrowGeom()

    const c   = this._colour
    const css = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`

    ctx.fillStyle   = css
    ctx.strokeStyle = css
    ctx.lineWidth   = w

    if (!this._arrowStart && !this._arrowEnd) {
      // Simple case: single round-capped stroke → one draw call, one shadow.
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(this._start.x, this._start.y)
      ctx.lineTo(this._end.x,   this._end.y)
      ctx.stroke()
      return
    }

    // One or both arrowheads present.
    // Strategy:
    //   1. Draw the line body with butt caps, extending 1px under each arrowhead
    //      to close any anti-aliasing gap at the junction.
    //   2. Explicitly fill a circle at each non-arrowhead end to restore the
    //      round cap there.
    //   3. Fill each arrowhead triangle so its base meets the body end.

    // Body endpoints: trimmed to arrowhead base positions.
    const bsx = this._start.x + udx * aLen
    const bsy = this._start.y + udy * aLen
    const bex = this._end.x   - udx * aLen
    const bey = this._end.y   - udy * aLen

    // Extend body 1px under arrowheads to avoid AA gaps at the junction.
    const OVERLAP = 1
    const lineS = {
      x: this._arrowStart ? bsx - udx * OVERLAP : this._start.x,
      y: this._arrowStart ? bsy - udy * OVERLAP : this._start.y,
    }
    const lineE = {
      x: this._arrowEnd ? bex + udx * OVERLAP : this._end.x,
      y: this._arrowEnd ? bey + udy * OVERLAP : this._end.y,
    }

    ctx.lineCap = 'butt'
    ctx.beginPath()
    ctx.moveTo(lineS.x, lineS.y)
    ctx.lineTo(lineE.x, lineE.y)
    ctx.stroke()

    // Round caps at non-arrowhead ends (full circle = round lineCap equivalent).
    if (!this._arrowStart) {
      ctx.beginPath()
      ctx.arc(this._start.x, this._start.y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    if (!this._arrowEnd) {
      ctx.beginPath()
      ctx.arc(this._end.x, this._end.y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Arrowhead triangles.
    // Both use +/- perp of the main axis for their wing points; the tip
    // is exactly at _end / _start and the base center is at (bex/bsx, bey/bsy).
    if (this._arrowEnd) {
      ctx.beginPath()
      ctx.moveTo(this._end.x, this._end.y)
      ctx.lineTo(bex + nx * hw, bey + ny * hw)
      ctx.lineTo(bex - nx * hw, bey - ny * hw)
      ctx.closePath()
      ctx.fill()
    }
    if (this._arrowStart) {
      ctx.beginPath()
      ctx.moveTo(this._start.x, this._start.y)
      ctx.lineTo(bsx + nx * hw, bsy + ny * hw)
      ctx.lineTo(bsx - nx * hw, bsy - ny * hw)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ----------------------------------------------------------
  // renderSelf — single drawImage to pick up one shadow
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    // If canvas was resized between recomputes, rebuild before drawing.
    const cw = Node.canvasWidth, ch = Node.canvasHeight
    if (this._canvas.width !== cw || this._canvas.height !== ch) this._updateCanvas()
    ctx.drawImage(this._canvas, 0, 0)
  }

  // ----------------------------------------------------------
  // renderPanel
  // ----------------------------------------------------------

  renderPanel(ctx: Ctx2D): void {
    this._drawSimplePill(ctx, this.bounds)
    this._drawCanvasPill(ctx)
    this._drawHandles(ctx)
  }

  private _drawSimplePill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()
    ctx.fillStyle    = 'rgba(255,255,255,0.75)'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Line', x + 12, y + height / 2)
    ctx.restore()
  }

  private _drawCanvasPill(ctx: Ctx2D): void {
    const { x, y, width, height } = this.canvasBounds
    if (width <= 0 || height <= 0) return
    const midY   = y + height / 2
    const BTN_SZ = Math.max(16, height - 8)
    const btnY   = y + (height - BTN_SZ) / 2

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe reflects the live line colour.
    const c = this._colour
    ctx.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},1)`
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('Line', x + 12, midY)

    ctx.font      = '10px monospace'
    ctx.fillStyle = this.widthSlot.isActive ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.70)'
    ctx.fillText(`${this._strokeWidth.toFixed(1)}px`, x + 54, midY)

    // Arrow toggles at right edge: end (▶) first (rightmost), then start (◀).
    let btnX = x + width - BTN_SZ - 3
    this._arrowEndBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }
    this._renderArrowBtn(ctx, this._arrowEndBounds, '▶', this._arrowEnd, midY)
    btnX -= BTN_SZ + 4
    this._arrowStartBounds = { x: btnX, y: btnY, width: BTN_SZ, height: BTN_SZ }
    this._renderArrowBtn(ctx, this._arrowStartBounds, '◀', this._arrowStart, midY)

    ctx.restore()
  }

  private _renderArrowBtn(ctx: Ctx2D, b: BBox, label: string, active: boolean, midY: number): void {
    ctx.fillStyle = active ? ACCENT + '44' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(b.x, b.y, b.width, b.height, 3)
    ctx.fill()
    ctx.strokeStyle = active ? ACCENT : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.roundRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1, 3)
    ctx.stroke()
    ctx.font         = '11px monospace'
    ctx.fillStyle    = active ? ACCENT : 'rgba(255,255,255,0.55)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, b.x + b.width / 2, midY)
  }

  private _drawHandles(ctx: Ctx2D): void {
    ctx.save()
    this._drawHandle(ctx, this._start, this.startSlot.isActive, this.startSlot.state === SlotState.SuspendedBound)
    this._drawHandle(ctx, this._end,   this.endSlot.isActive,   this.endSlot.state   === SlotState.SuspendedBound)
    ctx.restore()
  }

  private _drawHandle(ctx: Ctx2D, pt: Point, bound: boolean, suspended: boolean): void {
    const alpha = bound ? 0.45 : suspended ? 0.60 : 0.85
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`
    ctx.fillStyle   = `rgba(255,255,255,${alpha * 0.25})`
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, HANDLE_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.lineWidth   = 1
    ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.75})`
    ctx.beginPath()
    ctx.moveTo(pt.x - HANDLE_R + 2, pt.y); ctx.lineTo(pt.x + HANDLE_R - 2, pt.y)
    ctx.moveTo(pt.x, pt.y - HANDLE_R + 2); ctx.lineTo(pt.x, pt.y + HANDLE_R - 2)
    ctx.stroke()
  }

  // ----------------------------------------------------------
  // renderSlots — standard slot rows + width slider pill
  // ----------------------------------------------------------

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    this.renderSlotGroup(ctx, [this.startSlot, this.endSlot, this.colourSlot], this.panelBottom)
    this._drawWidthPill(ctx)
  }

  private _widthPillBounds(): BBox {
    const mainH = 3 * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return {
      x:      contentLeft(Node.canvasWidth),
      y:      this.panelBottom + mainH + 8,
      width:  panelWidth(Node.canvasWidth),
      height: 2 * SLOT_H + SLOT_GAP,
    }
  }

  private _widthSliderRowBounds(): BBox {
    const pb = this._widthPillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  private _widthBindRowBounds(): BBox {
    const pb = this._widthPillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _widthSliderGeom() {
    const b          = this._widthSliderRowBounds()
    const midY       = b.y + b.height / 2
    const labelX     = b.x + 12
    const indX       = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0       = labelX + SW_LABEL_W
    const sldR       = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _drawWidthPill(ctx: Ctx2D): void {
    this._drawWidthSlider(ctx)
    this.renderSlotGroup(ctx, [this.widthSlot], this._widthBindRowBounds().y)
  }

  private _drawWidthSlider(ctx: Ctx2D): void {
    const g      = this._widthSliderGeom()
    const { x, y, width, height } = g.b
    const active = this.widthSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01    = Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_W))

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, 6)
    ctx.fill()

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('stroke width', g.labelX, g.midY)

    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, v01, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(`${this._strokeWidth.toFixed(1)}px`, g.valueRight, g.midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

    ctx.restore()
  }

  private _drawSlider(ctx: Ctx2D, midY: number, x0: number, x1: number, v: number, colour: string): void {
    const thumbR = 5
    const lo     = x0 + thumbR
    const hi     = x1 - thumbR
    const range  = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap     = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 3
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(hi, midY); ctx.stroke()

    ctx.strokeStyle = colour
    ctx.beginPath(); ctx.moveTo(lo, midY); ctx.lineTo(thumbX, midY); ctx.stroke()

    ctx.fillStyle = colour
    ctx.beginPath(); ctx.arc(thumbX, midY, thumbR, 0, Math.PI * 2); ctx.fill()
  }

  private _setWidthFromPointer(px: number): void {
    if (this.widthSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.widthSlot)?.toggle()
    const g      = this._widthSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this._strokeWidth = Math.max(0.5, Math.max(0, Math.min(1, (px - lo) / range)) * MAX_STROKE_W)
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (this._drag !== null || this._sliderDrag) return this
    if (this._arrowStartBounds !== null && this._inBox(point, this._arrowStartBounds)) return this
    if (this._arrowEndBounds   !== null && this._inBox(point, this._arrowEndBounds))   return this
    if (this._inBox(point, this._widthSliderRowBounds())) return this
    if (ptDist(point, this._start) <= HANDLE_HIT) return this
    if (ptDist(point, this._end)   <= HANDLE_HIT) return this
    return null
  }

  private _inBox(p: Point, b: BBox): boolean {
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (this._arrowStartBounds !== null && this._inBox(point, this._arrowStartBounds)) {
      this._arrowStart = !this._arrowStart
      this.markDirty()
      return true
    }
    if (this._arrowEndBounds !== null && this._inBox(point, this._arrowEndBounds)) {
      this._arrowEnd = !this._arrowEnd
      this.markDirty()
      return true
    }

    if (this._inBox(point, this._widthSliderRowBounds())) {
      this._sliderDrag = true
      this._setWidthFromPointer(point.x)
      return true
    }

    if (ptDist(point, this._start) <= HANDLE_HIT) {
      if (this.startSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.startSlot)?.toggle()
      this._drag = 'start'
      this._dragStartMouse = { ...point }
      this._dragStartPt    = { ...this._start }
      return true
    }

    if (ptDist(point, this._end) <= HANDLE_HIT) {
      if (this.endSlot.state === SlotState.Bound) BindingLayer.findForSlot(this.endSlot)?.toggle()
      this._drag = 'end'
      this._dragStartMouse = { ...point }
      this._dragStartPt    = { ...this._end }
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._sliderDrag) {
      this._setWidthFromPointer(point.x)
      return
    }
    if (this._drag === null || this._dragStartMouse === null || this._dragStartPt === null) return
    const newPt = {
      x: this._dragStartPt.x + point.x - this._dragStartMouse.x,
      y: this._dragStartPt.y + point.y - this._dragStartMouse.y,
    }
    if (this._drag === 'start') this._start = newPt
    else                        this._end   = newPt
    this.markDirty()
  }

  handlePointerUp(): void {
    this._drag           = null
    this._dragStartMouse = null
    this._dragStartPt    = null
    this._sliderDrag     = false
  }
}
