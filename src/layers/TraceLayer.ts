import { Layer }         from '../core/Layer.js'
import { Node }          from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type Amount, type AmountSource,
  type Colour, type ColourSource,
  type EventValue, type EventSource,
  type ImageValue, type ImageSource,
  type MaskValue, type MaskSource,
  type Point, type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { SliderRegion }  from '../regions/SliderRegion.js'
import { detectContour } from './contourTrace.js'

// ------------------------------------------------------------
// TraceLayer — closed path traced from the boundary of a mask
// (or, when no mask is supplied, the largest connected region in
// a thresholded grayscale image).
// ------------------------------------------------------------
//
// Outputs: Point (phase position on perimeter) + Mask + Image —
// the same type set as ShapeLayer, so it plugs into any consumer
// that accepts a shape (AnimPath shapeSlot, MaskLayer shape slot,
// CompositeLayer, etc.).
//
// Pipeline (mask present):
//   1. Downsample mask to PROC_SIZE work buffer.
//   2. Moore's neighbour boundary tracing → ordered perimeter chain.
//   3. Uniform arc-length resample to N control points.
//   4. Scale back to canvas coords → 1-pass smooth → Catmull-Rom.
//
// Pipeline (no mask):
//   1. Downsample image, convert to greyscale.
//   2. Gaussian blur → Otsu threshold → binary.
//   3. Largest 4-connected component → same boundary trace.
//
// Detection inputs:
//   imageSlot (Image)  — source bitmap
//   maskSlot  (Mask)   — optional; preferred shape source
//
// Shape rendering inputs (like PathLayer):
//   phaseSlot       (Amount) — position along perimeter [0, 1]
//   colourSlot      (Colour)
//   opacitySlot     (Amount)
//   fillModeSlot    (Event)  — each pulse toggles fill ↔ outline
//   strokeWidthSlot (Amount)

const ACCENT     = '#e8a04a'   // shape amber — matches Rect/Ellipse/Path
const DIR_ACCENT = '#7ecfcf'
const AM_COL     = '#4a8fe8'
const MIN_POINTS = 4
const MAX_POINTS = 32
const DEF_POINTS = 10
const RENDER_PTS = 200
const LABEL_W    = 46
const BTN_W      = 54
const BTN_H      = 22
const BTN_M      = 6
const CP_R       = 6    // control-point handle radius
const HIT_R      = 14   // pointer hit radius
const ROT_OFF    = 24   // rotate handle offset beyond max radius

// Stroke-control pill constants (match ShapeLayer)
const SLOT_H          = 30
const SLOT_GAP        = 4
const CTRL_BTN_SZ     = SLOT_H - 6
const SW_LABEL_W      = 78
const SW_VALUE_W      = 38
const MAX_STROKE_WIDTH = 30

// ── Geometry helpers ─────────────────────────────────────────────

function rotatePoint(p: Point, c: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

// ── Catmull-Rom ──────────────────────────────────────────────────

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * (2*p1 + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t*t + (-p0+3*p1-3*p2+p3)*t*t*t)
}

function sampleSpline(t: number, pts: Point[]): Point {
  const n = pts.length
  const s = (((t % 1) + 1) % 1) * n
  const i = Math.floor(s), u = s - i
  const p0=pts[(i-1+n)%n]!, p1=pts[i]!, p2=pts[(i+1)%n]!, p3=pts[(i+2)%n]!
  return { x: catmullRom(u,p0.x,p1.x,p2.x,p3.x), y: catmullRom(u,p0.y,p1.y,p2.y,p3.y) }
}

type BBox = { x: number; y: number; width: number; height: number }

// ── TraceLayer ────────────────────────────────────────────────────

export class TraceLayer extends Layer implements PointSource, MaskSource, ImageSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point, ValueType.Mask, ValueType.Image])

  // Detection inputs
  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot

  // Shape rendering inputs
  readonly phaseSlot:       ParameterSlot
  readonly colourSlot:      ParameterSlot
  readonly opacitySlot:     ParameterSlot
  readonly fillModeSlot:    ParameterSlot
  readonly strokeWidthSlot: ParameterSlot

  private readonly _numPtsSlider: SliderRegion

  // Detection state
  private _phase:          number  = 0
  private _controlPoints:  Point[] = []
  private _lastImageId:    object | null = null
  private _lastNumPts:     number  = DEF_POINTS
  private _lastMaskActive: boolean = false
  private _forceDetect:    boolean = false

  // Shape rendering state
  private _colour:      Colour     = { r: 1, g: 1, b: 1, a: 1 }
  private _opacity:     number     = 1
  private _filled:      boolean    = true
  private _strokeWidth: number     = 2
  private _lastEventTime: EventValue = null

  // Offscreen canvases for Mask and Image outputs
  private _maskCanvas:  OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _imageCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  // UI state
  private _toggleBounds:    BBox | null = null
  private _strokeSliderDrag = false

  // Handle drag state
  private _angle:           number = 0
  private _dragIndex:       number = -1
  private _specialDrag:     'center' | 'size' | 'rotate' | null = null
  private _dragStartPtr:    Point = { x: 0, y: 0 }
  private _dragStartPts:    Point[] = []
  private _dragStartCenter: Point = { x: 0, y: 0 }
  private _dragStartAngle:  number = 0

  constructor() {
    super()
    this.imageSlot       = new ParameterSlot(ValueType.Image,  this, 'image')
    this.maskSlot        = new ParameterSlot(ValueType.Mask,   this, 'mask')
    this.phaseSlot       = new ParameterSlot(ValueType.Amount, this, 'phase')
    this.colourSlot      = new ParameterSlot(ValueType.Colour, this, 'colour')
    this.opacitySlot     = new ParameterSlot(ValueType.Amount, this, 'opacity')
    this.fillModeSlot    = new ParameterSlot(ValueType.Event,  this, 'outline mode')
    this.strokeWidthSlot = new ParameterSlot(ValueType.Amount, this, 'stroke width')
    const initV = (DEF_POINTS - MIN_POINTS) / (MAX_POINTS - MIN_POINTS)
    this._numPtsSlider = new SliderRegion(this, initV)
    this.slots.push(
      this.imageSlot, this.maskSlot,
      this.phaseSlot, this.colourSlot, this.opacitySlot,
      this.fillModeSlot, this.strokeWidthSlot,
    )
    this.debugName = 'Trace'
    graph.register(this)
  }

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
      { slot: this.maskSlot,  accepts: (l: Layer) => l.types.has(ValueType.Mask)  },
    ]
  }

  // ── Source interface ─────────────────────────────────────────────

  getPoint(): Point {
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(this._phase, this._controlPoints)
  }

  samplePerimeter(t: number): Point {
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(t, this._controlPoints)
  }

  getMask():  MaskValue  { return this._maskCanvas  }
  getImage(): ImageValue { return this._imageCanvas }

  setValue(_v: Amount): void { this.markDirty() }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:         this._phase,
      controlPoints: this._controlPoints,
      numPtsValue:   this._numPtsSlider.value,
      colour:        this._colour,
      opacity:       this._opacity,
      filled:        this._filled,
      strokeWidth:   this._strokeWidth,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number')        this._phase = state.phase
    if (Array.isArray(state.controlPoints))     this._controlPoints = state.controlPoints as Point[]
    if (typeof state.numPtsValue === 'number') {
      this._numPtsSlider.setValue(state.numPtsValue as Amount)
      this._lastNumPts = this._numPoints()
    }
    if (state.colour)                           this._colour = state.colour as Colour
    if (typeof state.opacity === 'number')      this._opacity = state.opacity
    if (typeof state.filled === 'boolean')      this._filled = state.filled
    if (typeof state.strokeWidth === 'number')  this._strokeWidth = state.strokeWidth
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.phaseSlot.isActive)
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount

    if (this.colourSlot.isActive)
      this._colour = (this.colourSlot.source as ColourSource).getColour()

    if (this.opacitySlot.isActive)
      this._opacity = (this.opacitySlot.source as AmountSource).getAmount() as Amount

    if (this.fillModeSlot.isActive) {
      const t = (this.fillModeSlot.source as EventSource).getEventTime()
      if (t !== null && t !== this._lastEventTime) {
        this._lastEventTime = t
        this._filled = !this._filled
      }
    }

    if (this.strokeWidthSlot.isActive)
      this._strokeWidth = Math.max(0.5, (this.strokeWidthSlot.source as AmountSource).getAmount() * MAX_STROKE_WIDTH)

    const numPts     = this._numPoints()
    const maskActive = this.maskSlot.isActive
    const imageVal   = this.imageSlot.isActive
      ? (this.imageSlot.source as ImageSource).getImage() : null
    const maskVal    = maskActive
      ? (this.maskSlot.source as MaskSource).getMask() : null
    const imageId    = imageVal as object | null

    if ((this._forceDetect || imageId !== this._lastImageId ||
         numPts !== this._lastNumPts || maskActive !== this._lastMaskActive)
        && imageVal !== null) {
      this._lastImageId    = imageId
      this._lastNumPts     = numPts
      this._lastMaskActive = maskActive
      this._forceDetect    = false
      this._detectPath(imageVal, maskVal, numPts)
    } else if (imageVal === null && this._controlPoints.length > 0) {
      this._lastImageId = null; this._controlPoints = []
    }

    this._updateOffscreens()
  }

  // ── Detection pipeline ───────────────────────────────────────────

  private _numPoints(): number {
    return Math.round(MIN_POINTS + this._numPtsSlider.value * (MAX_POINTS - MIN_POINTS))
  }

  private _detectPath(
    imageSrc: ImageBitmap | OffscreenCanvas,
    maskSrc:  MaskValue,
    numPts:   number,
  ): void {
    const pts = detectContour(imageSrc, maskSrc as OffscreenCanvas | null, numPts)
    this._controlPoints = pts ?? []
  }

  // ── Offscreen canvases ───────────────────────────────────────────

  private _updateOffscreens(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight

    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h)
      this._maskCanvas = new OffscreenCanvas(w, h)
    const mctx = this._maskCanvas.getContext('2d')!
    mctx.clearRect(0, 0, w, h)
    if (this._controlPoints.length >= 3)
      this._drawSpline(mctx, { r: 1, g: 1, b: 1, a: 1 }, 1, true, 2)

    if (this._imageCanvas.width !== w || this._imageCanvas.height !== h)
      this._imageCanvas = new OffscreenCanvas(w, h)
    const ictx = this._imageCanvas.getContext('2d')!
    ictx.clearRect(0, 0, w, h)
    if (this._controlPoints.length >= 3)
      this._drawSpline(ictx, this._colour, this._opacity, this._filled, this._strokeWidth)
  }

  private _drawSpline(
    ctx: Ctx2D,
    colour: Colour,
    opacity: number,
    filled: boolean,
    strokeWidth: number,
  ): void {
    if (this._controlPoints.length < 3) return
    const css = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = sampleSpline(i / RENDER_PTS, this._controlPoints)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else         ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    if (filled) {
      ctx.fillStyle = css
      ctx.fill()
    } else {
      ctx.strokeStyle = css
      ctx.lineWidth   = strokeWidth
      ctx.stroke()
    }
    ctx.restore()
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    this._drawSpline(ctx, this._colour, this._opacity, this._filled, this._strokeWidth)
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(s => s !== this.fillModeSlot && s !== this.strokeWidthSlot)
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawStrokePill(ctx)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._drawControlHandles(ctx)
    if (this.phaseSlot.isActive) this._drawPhaseIndicator(ctx)
  }

  // ── Stroke-control pill (mirrors ShapeLayer pattern) ─────────────

  private _strokePillBounds(): BBox {
    const cb = this.canvasBounds
    const standardSlots = this.slots.filter(s => s !== this.fillModeSlot && s !== this.strokeWidthSlot)
    const standardH = standardSlots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 3 * SLOT_H + 2 * SLOT_GAP }
  }

  private _outlineRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  private _strokeRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _strokeBindRowBounds(): BBox {
    const pb = this._strokePillBounds()
    return { x: pb.x, y: pb.y + 2 * (SLOT_H + SLOT_GAP), width: pb.width, height: SLOT_H }
  }

  private _strokeSliderGeom() {
    const b = this._strokeRowBounds()
    const midY = b.y + b.height / 2
    const labelX = b.x + 12
    const indX = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0 = labelX + SW_LABEL_W
    const sldR = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _drawStrokePill(ctx: Ctx2D): void {
    this.renderSlotGroup(ctx, [this.fillModeSlot], this._outlineRowBounds().y)
    this._drawOutlineToggle(ctx)
    this._drawStrokeSlider(ctx)
    this.renderSlotGroup(ctx, [this.strokeWidthSlot], this._strokeBindRowBounds().y)
  }

  private _drawOutlineToggle(ctx: Ctx2D): void {
    const row  = this._outlineRowBounds()
    const midY = row.y + row.height / 2
    const btnX = row.x + row.width - CTRL_BTN_SZ - 3
    const btnY = row.y + 3
    this._toggleBounds = { x: btnX, y: btnY, width: CTRL_BTN_SZ, height: CTRL_BTN_SZ }

    const state       = this.fillModeSlot.state
    const isActive    = state === SlotState.Bound
    const isSuspended = state === SlotState.SuspendedBound
    const outlineMode = !this._filled

    ctx.save()
    ctx.fillStyle = isActive ? ACCENT + '33' : isSuspended ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnX, btnY, CTRL_BTN_SZ, CTRL_BTN_SZ, 3)
    ctx.fill()

    ctx.strokeStyle = isActive ? ACCENT + '99' : 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    if (isSuspended) ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.roundRect(btnX + 0.5, btnY + 0.5, CTRL_BTN_SZ - 1, CTRL_BTN_SZ - 1, 3)
    ctx.stroke()
    ctx.setLineDash([])

    const colour = isActive ? ACCENT : isSuspended ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.70)'
    ctx.strokeStyle = colour
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.arc(btnX + CTRL_BTN_SZ / 2, midY, 4, 0, Math.PI * 2)
    ctx.stroke()
    if (outlineMode) {
      ctx.fillStyle = colour
      ctx.beginPath()
      ctx.arc(btnX + CTRL_BTN_SZ / 2, midY, 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private _drawStrokeSlider(ctx: Ctx2D): void {
    const g = this._strokeSliderGeom()
    const { x, y, width, height } = g.b
    const active = this.strokeWidthSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01 = Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_WIDTH))

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
    const lo = x0 + thumbR, hi = x1 - thumbR
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

  private _strokeSliderHit(point: Point): boolean {
    return boundingBoxContains(this._strokeRowBounds(), point)
  }

  private _setStrokeWidthFromPointer(px: number): void {
    if (this.strokeWidthSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.strokeWidthSlot)?.toggle()
    }
    const g = this._strokeSliderGeom()
    const thumbR = 5
    const lo = g.sld0 + thumbR, hi = g.sldR - thumbR
    const range = Math.max(1e-6, hi - lo)
    const v = Math.max(0, Math.min(1, (px - lo) / range))
    this._strokeWidth = Math.max(0.5, v * MAX_STROKE_WIDTH)
    this.markDirty()
  }

  // ── Pill rendering ───────────────────────────────────────────────

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return
    const midY    = y + height / 2
    const btnB    = this._detectBtnBounds(b)
    const swatchX = x + 16
    const sliderX = swatchX + 18   // start slider after colour swatch
    const sliderW = Math.max(0, btnB.x - sliderX - LABEL_W - 8)
    this._numPtsSlider.bounds = { x: sliderX, y: y + 6, width: sliderW, height: Math.max(0, height - 12) }
    this._numPtsSlider.interactive = true
    this._numPtsSlider.displayValue = this._numPtsSlider.value

    ctx.save()

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Colour swatch
    const c = this._colour
    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.beginPath()
    ctx.arc(swatchX, midY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    // Num-points slider
    this._numPtsSlider.renderSelf(ctx)

    // Points count label
    const hasPts = this._controlPoints.length > 0
    ctx.font      = '11px monospace'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = hasPts ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.35)'
    ctx.fillText(
      hasPts ? `${this._controlPoints.length} pts`
             : this.imageSlot.isActive ? '…' : '—',
      sliderX + sliderW + 4, midY,
    )

    // DETECT button
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnB.x, btnB.y, btnB.width, btnB.height, 4)
    ctx.fill()
    ctx.font      = 'bold 10px monospace'
    ctx.fillStyle = ACCENT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('DETECT', btnB.x + btnB.width / 2, btnB.y + btnB.height / 2)

    ctx.restore()
  }

  // ── Interaction ──────────────────────────────────────────────────

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): Node | null {
    // Return the slider region itself so it handles its own pointer events.
    const sliderHit = this._numPtsSlider.hitTest(point)
    if (sliderHit !== null) return sliderHit

    // Toggle button (outline mode)
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) return this

    // Stroke-width slider row
    if (this._strokeSliderHit(point)) return this

    // DETECT button (canvas-space pill)
    if (boundingBoxContains(this._detectBtnBounds(this.canvasBounds), point)) return this

    if (this._controlPoints.length < 2) return null
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x-c.x)**2 + (point.y-c.y)**2 <= r2) return this
    const sh = this._sizeHandlePos()
    if ((point.x-sh.x)**2 + (point.y-sh.y)**2 <= r2) return this
    const rh = this._rotateHandlePos()
    if ((point.x-rh.x)**2 + (point.y-rh.y)**2 <= r2) return this
    if (this._nearest(point) >= 0) return this
    return this._curveHit(point) !== null ? this : null
  }

  handlePointerDown(point: Point): boolean {
    // Outline mode toggle
    if (this._toggleBounds !== null && boundingBoxContains(this._toggleBounds, point)) {
      if (this.fillModeSlot.state === SlotState.Bound) {
        this.fillModeSlot.suspend()
      } else if (this.fillModeSlot.state === SlotState.SuspendedBound) {
        this.fillModeSlot.resume()
      } else {
        this._filled = !this._filled
      }
      this.markDirty()
      return true
    }

    // Stroke-width slider
    if (this._strokeSliderHit(point)) {
      this._strokeSliderDrag = true
      this._setStrokeWidthFromPointer(point.x)
      this.markDirty()
      return true
    }

    // DETECT button
    if (boundingBoxContains(this._detectBtnBounds(this.canvasBounds), point)) {
      this._forceDetect = true; this.markDirty(); return true
    }

    if (this._controlPoints.length < 2) return false

    const r2 = HIT_R * HIT_R
    const c  = this._centroid()

    // Centre handle
    if ((point.x-c.x)**2 + (point.y-c.y)**2 <= r2) {
      this._specialDrag     = 'center'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this.markDirty(); return true
    }
    // Size handle
    const sh = this._sizeHandlePos()
    if ((point.x-sh.x)**2 + (point.y-sh.y)**2 <= r2) {
      this._specialDrag     = 'size'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this._dragStartCenter = c
      this.markDirty(); return true
    }
    // Rotate handle
    const rh = this._rotateHandlePos()
    if ((point.x-rh.x)**2 + (point.y-rh.y)**2 <= r2) {
      this._specialDrag     = 'rotate'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._controlPoints.map(p => ({ ...p }))
      this._dragStartCenter = c
      this._dragStartAngle  = this._angle
      this.markDirty(); return true
    }
    // Control point
    const idx = this._nearest(point)
    if (idx >= 0) {
      this._dragIndex = idx; this.markDirty(); return true
    }
    // Click on curve: insert new point
    const hit = this._curveHit(point)
    if (hit !== null) {
      this._controlPoints.splice(hit.insertAt, 0, { ...hit.pos })
      this._dragIndex = hit.insertAt
      this.markDirty(); return true
    }
    return false
  }

  handleContextMenu(point: Point): boolean {
    if (this._controlPoints.length <= MIN_POINTS) return false
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._controlPoints.splice(idx, 1)
    if (this._dragIndex === idx) this._dragIndex = -1
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
    if (this._strokeSliderDrag) {
      this._setStrokeWidthFromPointer(point.x)
      return
    }
    if (this._specialDrag === 'center') {
      const dx = point.x - this._dragStartPtr.x
      const dy = point.y - this._dragStartPtr.y
      this._controlPoints = this._dragStartPts.map(p => ({ x: p.x+dx, y: p.y+dy }))
      this.markDirty(); return
    }
    if (this._specialDrag === 'size') {
      const c0  = this._dragStartCenter
      const d0  = Math.hypot(this._dragStartPtr.x-c0.x, this._dragStartPtr.y-c0.y)
      const d1  = Math.hypot(point.x-c0.x, point.y-c0.y)
      const scl = d0 > 0 ? d1/d0 : 1
      this._controlPoints = this._dragStartPts.map(p => ({
        x: c0.x + (p.x-c0.x)*scl, y: c0.y + (p.y-c0.y)*scl,
      }))
      this.markDirty(); return
    }
    if (this._specialDrag === 'rotate') {
      const c0    = this._dragStartCenter
      const a0    = Math.atan2(this._dragStartPtr.y-c0.y, this._dragStartPtr.x-c0.x)
      const a1    = Math.atan2(point.y-c0.y, point.x-c0.x)
      const delta = a1 - a0
      this._controlPoints = this._dragStartPts.map(p => rotatePoint(p, c0, delta))
      this._angle = this._dragStartAngle + delta
      this.markDirty(); return
    }
    if (this._dragIndex >= 0) {
      this._controlPoints[this._dragIndex] = { ...point }
      this.markDirty()
    }
  }

  override handlePointerUp(): void {
    this._specialDrag      = null
    this._dragIndex        = -1
    this._strokeSliderDrag = false
    this.markDirty()
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _detectBtnBounds(b: BBox) {
    return { x: b.x + b.width - BTN_M - BTN_W, y: b.y + (b.height - BTN_H) / 2, width: BTN_W, height: BTN_H }
  }

  private _centroid(): Point {
    if (this._controlPoints.length === 0) return { x: 0, y: 0 }
    const x = this._controlPoints.reduce((s, p) => s + p.x, 0) / this._controlPoints.length
    const y = this._controlPoints.reduce((s, p) => s + p.y, 0) / this._controlPoints.length
    return { x, y }
  }

  private _sizeHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._controlPoints.reduce((r, p) => Math.max(r, Math.hypot(p.x-c.x, p.y-c.y)), 0)
    return { x: c.x + maxR + 24, y: c.y }
  }

  private _rotateHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._controlPoints.reduce((r, p) => Math.max(r, Math.hypot(p.x-c.x, p.y-c.y)), 0)
    const a    = this._angle - Math.PI / 2
    return { x: c.x + (maxR + ROT_OFF) * Math.cos(a), y: c.y + (maxR + ROT_OFF) * Math.sin(a) }
  }

  private _nearest(p: Point): number {
    const r2 = HIT_R * HIT_R
    let best = -1, bestD = Infinity
    for (let i = 0; i < this._controlPoints.length; i++) {
      const cp = this._controlPoints[i]!
      const d2 = (p.x-cp.x)**2 + (p.y-cp.y)**2
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = i }
    }
    return best
  }

  private _curveHit(p: Point): { insertAt: number; pos: Point } | null {
    const n = this._controlPoints.length
    if (n < 2) return null
    const r2 = HIT_R * HIT_R
    let bestT = 0, bestD2 = Infinity, bestPos: Point = { x: 0, y: 0 }
    for (let i = 0; i <= RENDER_PTS; i++) {
      const t  = (i / RENDER_PTS) % 1
      const pt = sampleSpline(t, this._controlPoints)
      const d2 = (p.x-pt.x)**2 + (p.y-pt.y)**2
      if (d2 < bestD2) { bestD2 = d2; bestT = t; bestPos = pt }
    }
    if (bestD2 > r2) return null
    const segIndex = Math.min(n-1, Math.floor(bestT * n))
    return { insertAt: segIndex + 1, pos: bestPos }
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._controlPoints.length < 2) return
    const c  = this._centroid()
    const sh = this._sizeHandlePos()
    const rh = this._rotateHandlePos()

    ctx.save()

    // Spline outline overlay
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = sampleSpline(i / RENDER_PTS, this._controlPoints)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else         ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.strokeStyle = 'rgba(232,160,74,0.70)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([])
    ctx.stroke()

    // Dashed guide lines
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sh.x, sh.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(rh.x, rh.y); ctx.stroke()
    ctx.setLineDash([])

    // Control point handles
    for (let i = 0; i < this._controlPoints.length; i++) {
      const pt  = this._controlPoints[i]!
      const lit = i === this._dragIndex
      ctx.fillStyle   = lit ? ACCENT : 'rgba(232,160,74,0.30)'
      ctx.strokeStyle = lit ? '#ffffff' : ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath(); ctx.arc(pt.x, pt.y, CP_R, 0, Math.PI*2)
      ctx.fill(); ctx.stroke()
    }

    // Centre handle
    const litC = this._specialDrag === 'center'
    ctx.fillStyle   = litC ? '#ffffff' : ACCENT
    ctx.strokeStyle = litC ? ACCENT : 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(c.x, c.y, CP_R+2, 0, Math.PI*2)
    ctx.fill(); ctx.stroke()

    // Size handle (square)
    const litS = this._specialDrag === 'size'
    const hs   = CP_R
    ctx.fillStyle   = litS ? ACCENT : 'rgba(255,255,255,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.fillRect(sh.x-hs, sh.y-hs, hs*2, hs*2)
    ctx.strokeRect(sh.x-hs, sh.y-hs, hs*2, hs*2)

    // Rotate handle (circle)
    const litR = this._specialDrag === 'rotate'
    ctx.fillStyle   = litR ? '#ffffff' : 'rgba(232,160,74,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(rh.x, rh.y, CP_R, 0, Math.PI*2)
    ctx.fill(); ctx.stroke()

    ctx.restore()
  }

  private _drawPhaseIndicator(ctx: Ctx2D): void {
    const cp = this.getPoint()
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.arc(cp.x, cp.y, 8, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }
}
