import { Layer }        from '../core/Layer.js'
import { Node }         from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType, SlotState,
  type Colour, type ColourSource,
  type AmountSource,
  type Point,  type PointSource,
  type ImageValue, type ImageSource,
  type MaskValue,  type MaskSource,
  type Direction,  type DirectionSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { BindingLayer }  from './BindingLayer.js'
import { contentLeft, panelWidth } from '../interaction/layout.js'

// ------------------------------------------------------------
// StrokeLayer — freehand stroke fitted to cubic Bézier curves
// ------------------------------------------------------------
//
// Drawing: while selected, click "✎ draw" in the panel (or on a
// freshly-created layer) then drag on the canvas. On pointer-up
// the raw polyline is simplified with Ramer-Douglas-Peucker
// (ε = 8 px) and fitted to G1-continuous cubic Bézier segments
// using Catmull-Rom tangents; the number of segments adapts to
// stroke complexity automatically.
//
// Transform: ImageLayer-style three handles —
//   ⊕  Move (circle+crosshair) at centroid
//   □  Scale (square, lower-right) — uniform scale
//   ○  Rotate (circle on arm) — above centroid
//
// If start or end slots are bound when a handle is dragged, the
// bindings are suspended and the current offset is baked into the
// centroid so the stroke does not jump.
//
// Sources:
//   PointSource  — getPoint() returns stroke midpoint; samplePerimeter(t)
//                  provides arc-length-parameterised traversal for AnimPath.
//   MaskSource   — closed with a virtual straight line for mask fill.
//
// Slots: Amount (width 0–30px), Colour, Point (start pin), Point (end pin).
// AnimPath provides its own phase; StrokeLayer needs no phase slot.

const ACCENT     = '#e86a4a'
const AM_COL     = '#4a8fe8'   // Amount type accent (stroke-width slot)
const HANDLE_R   = 7     // circle handle radius
const HANDLE_SZ  = 6     // square handle half-size
const HANDLE_HIT = 14    // pointer hit radius
const ROT_ARM    = 85    // rotation arm length from centre (px)
const ARC_STEP   = 20    // sub-samples per Bézier segment for arc table
const RDP_EPS    = 8     // Ramer-Douglas-Peucker tolerance (px)
const MAX_HANDLE_BOOST = 3   // cap on control-point lengthening when shrunk below drawn size

// Stroke-width control pill (slider + binding row), drawn directly below
// the standard slot pill — see ShapeLayer's stroke-control pill.
const SLOT_H    = 26
const SLOT_GAP  = 4
const SW_LABEL_W = 78
const SW_VALUE_W = 38
const MAX_STROKE_WIDTH = 30   // Amount [0,1] -> stroke width [0.5, 30] px

type DragState =
  | { type: 'move';   startMouse: Point; startCx: number; startCy: number }
  | { type: 'scale';  center: Point; startDist: number; startScale: number }
  | { type: 'rotate'; center: Point; startAngle: number; startRot: number }

type Seg  = { p0: Point; cp1: Point; cp2: Point; p1: Point }
type BBox = { x: number; y: number; width: number; height: number }

function ptDist(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y) }

export class StrokeLayer extends Layer implements PointSource, ImageSource, MaskSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point, ValueType.Image, ValueType.Mask])

  // Parameter slots
  readonly widthSlot:    ParameterSlot
  readonly colourSlot:   ParameterSlot
  readonly startSlot:    ParameterSlot
  readonly endSlot:      ParameterSlot
  readonly rotationSlot: ParameterSlot

  // Drawing state
  private _drawMode  = true
  private _rawPoints: Point[] = []

  // Stroke data — local segments centred at origin (as drawn minus centroid)
  private _localSegs:   Seg[] = []
  // _localSegs with control-point handles lengthened when _computedScale < 1
  // (smoother small-scale rendering; recomputed each time, _localSegs untouched
  // so the original fit is preserved and the effect is fully reversible).
  private _renderSegs:  Seg[] = []
  private _hasStroke    = false
  private _localHalfW   = 100   // half-width of unscaled local bbox (for handle placement)
  private _localHalfH   = 60

  // Transform — base values (set by drawing + handle drag)
  private _cx:       number
  private _cy:       number
  private _scale     = 1.0
  private _rotation  = 0

  // Computed transform — derived in recompute() from base + slot bindings.
  // _localToCanvas uses these; _suspendEndpointSlots bakes them back into base.
  private _computedCx:       number
  private _computedCy:       number
  private _computedScale     = 1.0
  private _computedRotation  = 0

  // Rendered values
  private _strokeWidth  = 3
  private _colour: Colour = { r: 0.08, g: 0.08, b: 0.08, a: 1 }

  // Arc-length samples (canvas space, rebuilt in recompute)
  private _arcSamples: Point[] = []
  private _totalLen    = 0

  // Offscreen canvases
  private _imageCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)
  private _maskCanvas:  OffscreenCanvas = new OffscreenCanvas(1, 1)

  // Handle drag
  private _drag: DragState | null = null
  private _strokeSliderDrag = false

  // Draw-button bounds (written during renderPanel, read in hitTestSelf)
  private _drawBtnBounds: BBox | null = null

  constructor() {
    super()
    this._cx = Node.canvasWidth  / 2
    this._cy = Node.canvasHeight / 2
    this._computedCx       = this._cx
    this._computedCy       = this._cy
    this._computedRotation = 0

    this.widthSlot    = new ParameterSlot(ValueType.Amount,    this, 'width')
    this.colourSlot   = new ParameterSlot(ValueType.Colour,    this, 'colour')
    this.startSlot    = new ParameterSlot(ValueType.Point,     this, 'start')
    this.endSlot      = new ParameterSlot(ValueType.Point,     this, 'end')
    this.rotationSlot = new ParameterSlot(ValueType.Direction, this, 'rotation')
    this.slots.push(this.widthSlot, this.colourSlot, this.startSlot, this.endSlot, this.rotationSlot)

    graph.register(this)
  }

  // ----------------------------------------------------------
  // Source interfaces
  // ----------------------------------------------------------

  getPoint(): Point {
    // Midpoint of the stroke; used when AnimPath falls back from samplePerimeter.
    if (this._arcSamples.length === 0) return { x: this._cx, y: this._cy }
    return this.samplePerimeter(0.5)
  }

  // Arc-length-parameterised position along the open stroke.
  // t=0 → start, t=1 → end. Clamps at endpoints (no wrap), so AnimPath's
  // phase cycling produces an immediate jump back to start at t≈1→0.
  samplePerimeter(t: number): Point {
    if (this._arcSamples.length < 2) return { x: this._cx, y: this._cy }
    const target = Math.max(0, Math.min(1, t)) * this._totalLen
    let acc = 0
    for (let i = 1; i < this._arcSamples.length; i++) {
      const a = this._arcSamples[i - 1]!, b = this._arcSamples[i]!
      const d = ptDist(a, b)
      if (acc + d >= target || i === this._arcSamples.length - 1) {
        const f = d > 0 ? (target - acc) / d : 0
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      }
      acc += d
    }
    return { ...this._arcSamples[this._arcSamples.length - 1]! }
  }

  getImage(): ImageValue { return this._imageCanvas }
  getMask():  MaskValue  { return this._maskCanvas }

  // Actual canvas-space endpoints — used by main.ts to initialise a
  // PointLayer at the correct position when an empty slot is clicked.
  getStrokeStart(): Point {
    // Use base transform (not computed) so the initialised PointLayer matches
    // the current drawn position before any slot is active.
    return this._localToCanvasRaw(this._localSegs[0]?.p0 ?? { x: -this._localHalfW, y: 0 })
  }
  getStrokeEnd(): Point {
    const last = this._localSegs[this._localSegs.length - 1]
    return this._localToCanvasRaw(last?.p1 ?? { x: this._localHalfW, y: 0 })
  }

  // Seed a newly-created layer (via slot-click-to-create) with the value
  // currently shown by the corresponding manual control, so the binding
  // starts as a no-op.
  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | null {
    if (slot === this.widthSlot)    return Math.max(0, Math.min(1, this._strokeWidth / MAX_STROKE_WIDTH))
    if (slot === this.rotationSlot) return { angle: this._rotation, magnitude: 1 }
    return null
  }

  // Suppress pixel-pick scan while the user is actively sketching.
  get blockPixelPick(): boolean { return this._drawMode }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      localSegs:   this._localSegs,
      cx:          this._cx,
      cy:          this._cy,
      scale:       this._scale,
      rotation:    this._rotation,
      strokeWidth: this._strokeWidth,
      colour:      this._colour,
      hasStroke:   this._hasStroke,
      drawMode:    this._drawMode,
      localHalfW:  this._localHalfW,
      localHalfH:  this._localHalfH,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (Array.isArray(state.localSegs))       this._localSegs   = state.localSegs as Seg[]
    if (typeof state.cx === 'number')          this._cx          = state.cx
    if (typeof state.cy === 'number')          this._cy          = state.cy
    if (typeof state.scale === 'number')       this._scale       = state.scale
    if (typeof state.rotation === 'number')    this._rotation    = state.rotation
    if (typeof state.strokeWidth === 'number') this._strokeWidth = state.strokeWidth
    if (state.colour)                          this._colour      = state.colour as Colour
    if (typeof state.hasStroke === 'boolean')  this._hasStroke   = state.hasStroke
    if (typeof state.drawMode === 'boolean')   this._drawMode    = state.drawMode
    if (typeof state.localHalfW === 'number')  this._localHalfW  = state.localHalfW
    if (typeof state.localHalfH === 'number')  this._localHalfH  = state.localHalfH

    this._computedCx       = this._cx
    this._computedCy       = this._cy
    this._computedScale    = this._scale
    this._computedRotation = this._rotation
    this._renderSegs = this._localSegs
  }

  // ----------------------------------------------------------
  // Node
  // ----------------------------------------------------------

  protected recompute(): void {
    if (this.widthSlot.isActive) {
      this._strokeWidth = Math.max(0.5, (this.widthSlot.source as AmountSource).getAmount() * MAX_STROKE_WIDTH)
    }
    if (this.colourSlot.isActive) {
      this._colour = (this.colourSlot.source as ColourSource).getColour()
    }
    if (this.rotationSlot.isActive) {
      this._rotation = (this.rotationSlot.source as DirectionSource).getDirection().angle
    }

    // Compute effective transform from slot bindings.
    this._computedCx       = this._cx
    this._computedCy       = this._cy
    this._computedScale    = this._scale
    this._computedRotation = this._rotation

    const hasStroke   = this._localSegs.length > 0
    const startActive = this.startSlot.isActive && hasStroke
    const endActive   = this.endSlot.isActive   && hasStroke

    if (startActive && endActive) {
      // Both endpoints pinned: derive translation, scale, and rotation that
      // map the local start→end vector onto boundStart→boundEnd.
      const ls          = this._localSegs[0]!.p0
      const le          = this._localSegs[this._localSegs.length - 1]!.p1
      const startTarget = (this.startSlot.source as PointSource).getPoint()
      const endTarget   = (this.endSlot.source as PointSource).getPoint()
      const localLen    = ptDist(ls, le)
      if (localLen > 0.001) {
        const dx = endTarget.x - startTarget.x
        const dy = endTarget.y - startTarget.y
        this._computedScale    = Math.hypot(dx, dy) / localLen
        // Rotation that maps the local ls→le direction onto startTarget→endTarget
        const localAngle  = Math.atan2(le.y - ls.y, le.x - ls.x)
        const targetAngle = Math.atan2(dy, dx)
        this._computedRotation = targetAngle - localAngle
        const cos = Math.cos(this._computedRotation)
        const sin = Math.sin(this._computedRotation)
        this._computedCx = startTarget.x - (ls.x * cos - ls.y * sin) * this._computedScale
        this._computedCy = startTarget.y - (ls.x * sin + ls.y * cos) * this._computedScale
      } else {
        this._computedCx = startTarget.x - ls.x * this._computedScale
        this._computedCy = startTarget.y - ls.y * this._computedScale
      }
    } else if (startActive) {
      // Translate so the stroke's start reaches the bound point (scale/rotation unchanged).
      const target   = (this.startSlot.source as PointSource).getPoint()
      const startRaw = this._localToCanvasRaw(this._localSegs[0]!.p0)
      this._computedCx = this._cx + (target.x - startRaw.x)
      this._computedCy = this._cy + (target.y - startRaw.y)
    } else if (endActive) {
      // Resize + re-orient so the start stays fixed and the end exactly reaches
      // the bound point. Both scale and rotation are derived from the
      // start→target vector vs the local start→end vector.
      const ls       = this._localSegs[0]!.p0
      const le       = this._localSegs[this._localSegs.length - 1]!.p1
      const target   = (this.endSlot.source as PointSource).getPoint()
      const startRaw = this._localToCanvasRaw(ls)
      const localLen = ptDist(ls, le)
      if (localLen > 0.001) {
        const dx = target.x - startRaw.x
        const dy = target.y - startRaw.y
        this._computedScale    = Math.hypot(dx, dy) / localLen
        // Rotation that maps the local ls→le direction onto startRaw→target
        const localAngle  = Math.atan2(le.y - ls.y, le.x - ls.x)
        const targetAngle = Math.atan2(dy, dx)
        this._computedRotation = targetAngle - localAngle
        const cos = Math.cos(this._computedRotation)
        const sin = Math.sin(this._computedRotation)
        this._computedCx = startRaw.x - (ls.x * cos - ls.y * sin) * this._computedScale
        this._computedCy = startRaw.y - (ls.x * sin + ls.y * cos) * this._computedScale
      }
    }

    this._updateRenderSegs()
    this._rebuildArcSamples()
    this._updateImageCanvas()
    this._updateMask()
  }

  // ----------------------------------------------------------
  // Coordinate helpers
  // ----------------------------------------------------------

  private _localToCanvasRaw(lp: Point): Point {
    const cos = Math.cos(this._rotation), sin = Math.sin(this._rotation)
    const sx = lp.x * this._scale, sy = lp.y * this._scale
    return { x: this._cx + sx * cos - sy * sin, y: this._cy + sx * sin + sy * cos }
  }

  private _localToCanvas(lp: Point): Point {
    const cos = Math.cos(this._computedRotation), sin = Math.sin(this._computedRotation)
    const sx = lp.x * this._computedScale, sy = lp.y * this._computedScale
    return {
      x: this._computedCx + sx * cos - sy * sin,
      y: this._computedCy + sx * sin + sy * cos,
    }
  }

  // ----------------------------------------------------------
  // Render-time handle boost (smoother small-scale rendering)
  // ----------------------------------------------------------

  // When the stroke is rendered smaller than it was drawn, a uniformly-scaled
  // copy of the original curve can look more "jagged" relative to its own
  // size — fine local detail that read as deliberate at full size becomes
  // visual noise once shrunk. Lengthening each segment's control-point
  // handles (relative to that segment's own endpoints) rounds out corners
  // and transitions, making the small version read as smoother. Endpoints
  // (p0/p1, and therefore arc-length and AnimPath sampling) are unchanged —
  // only cp1/cp2 move further from their anchors.
  private _updateRenderSegs(): void {
    if (this._localSegs.length === 0) { this._renderSegs = this._localSegs; return }

    const scale = this._computedScale
    if (scale >= 1) { this._renderSegs = this._localSegs; return }

    const boost = Math.min(MAX_HANDLE_BOOST, 1 / Math.sqrt(scale))
    this._renderSegs = this._localSegs.map(s => ({
      p0:  s.p0,
      cp1: { x: s.p0.x + (s.cp1.x - s.p0.x) * boost, y: s.p0.y + (s.cp1.y - s.p0.y) * boost },
      cp2: { x: s.p1.x + (s.cp2.x - s.p1.x) * boost, y: s.p1.y + (s.cp2.y - s.p1.y) * boost },
      p1:  s.p1,
    }))
  }

  // ----------------------------------------------------------
  // Arc-length table and mask
  // ----------------------------------------------------------

  private _rebuildArcSamples(): void {
    if (this._renderSegs.length === 0) { this._arcSamples = []; this._totalLen = 0; return }
    const pts: Point[] = []
    for (let si = 0; si < this._renderSegs.length; si++) {
      const seg = this._renderSegs[si]!
      for (let i = (si === 0 ? 0 : 1); i <= ARC_STEP; i++) {
        pts.push(this._localToCanvas(this._evalBez(seg, i / ARC_STEP)))
      }
    }
    let len = 0
    for (let i = 1; i < pts.length; i++) len += ptDist(pts[i - 1]!, pts[i]!)
    this._arcSamples = pts
    this._totalLen   = len
  }

  private _evalBez(s: Seg, t: number): Point {
    const mt = 1 - t
    return {
      x: mt*mt*mt*s.p0.x + 3*mt*mt*t*s.cp1.x + 3*mt*t*t*s.cp2.x + t*t*t*s.p1.x,
      y: mt*mt*mt*s.p0.y + 3*mt*mt*t*s.cp1.y + 3*mt*t*t*s.cp2.y + t*t*t*s.p1.y,
    }
  }

  private _updateImageCanvas(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._imageCanvas.width !== w || this._imageCanvas.height !== h) {
      this._imageCanvas = new OffscreenCanvas(w, h)
    }
    const ctx = this._imageCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (this._localSegs.length === 0) return
    const c = this._colour
    ctx.strokeStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.lineWidth   = this._strokeWidth
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.beginPath()
    this._buildCtxPath(ctx)
    ctx.stroke()
  }

  private _updateMask(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h) {
      this._maskCanvas = new OffscreenCanvas(w, h)
    }
    const ctx = this._maskCanvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    if (this._localSegs.length === 0 || this._arcSamples.length < 2) return
    ctx.fillStyle = 'rgba(255,255,255,1)'
    ctx.beginPath()
    this._buildCtxPath(ctx)
    // Virtual straight closing line — makes an enclosed region for masking
    ctx.lineTo(this._arcSamples[0]!.x, this._arcSamples[0]!.y)
    ctx.closePath()
    ctx.fill()
  }

  // ----------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------

  renderSelf(ctx: Ctx2D): void {
    if (!this._drawMode && !this._hasStroke) return
    const c   = this._colour
    const css = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`

    ctx.save()
    ctx.lineCap  = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = this._strokeWidth

    if (this._drawMode && this._rawPoints.length >= 2) {
      ctx.strokeStyle = css.replace(/,([\d.]+)\)$/, ',0.60)')
      ctx.beginPath()
      this._rawPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.stroke()
    } else if (this._hasStroke) {
      ctx.strokeStyle = css
      ctx.beginPath()
      this._buildCtxPath(ctx)
      ctx.stroke()
    }
    ctx.restore()
  }

  private _buildCtxPath(ctx: Ctx2D): void {
    let first = true
    for (const seg of this._renderSegs) {
      const p0  = this._localToCanvas(seg.p0)
      const cp1 = this._localToCanvas(seg.cp1)
      const cp2 = this._localToCanvas(seg.cp2)
      const p1  = this._localToCanvas(seg.p1)
      if (first) { ctx.moveTo(p0.x, p0.y); first = false }
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p1.x, p1.y)
    }
  }

  renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
    if (this._hasStroke && !this._drawMode) {
      this._renderHandles(ctx)
    }
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(s => s !== this.widthSlot)
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawStrokeWidthPill(ctx)
  }

  private _strokeWidthPillBounds(): BBox {
    const standardSlots = this.slots.filter(s => s !== this.widthSlot)
    const standardH = standardSlots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return { x: contentLeft(Node.canvasWidth), y: this.panelBottom + standardH + 8, width: panelWidth(Node.canvasWidth), height: 2 * SLOT_H + SLOT_GAP }
  }

  private _strokeSliderRowBounds(): BBox {
    const pb = this._strokeWidthPillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  private _strokeBindRowBounds(): BBox {
    const pb = this._strokeWidthPillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _strokeSliderGeom() {
    const b = this._strokeSliderRowBounds()
    const midY = b.y + b.height / 2
    const labelX = b.x + 12
    const indX = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0 = labelX + SW_LABEL_W
    const sldR = valueRight - SW_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _drawStrokeWidthPill(ctx: Ctx2D): void {
    this._drawStrokeWidthSlider(ctx)
    this.renderSlotGroup(ctx, [this.widthSlot], this._strokeBindRowBounds().y)
  }

  private _drawStrokeWidthSlider(ctx: Ctx2D): void {
    const g = this._strokeSliderGeom()
    const { x, y, width, height } = g.b

    const active = this.widthSlot.isActive
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
    const lo = x0 + thumbR
    const hi = x1 - thumbR
    const range = Math.max(0, hi - lo)
    const thumbX = lo + Math.max(0, Math.min(1, v)) * range

    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 3
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

  private _setStrokeWidthFromPointer(px: number): void {
    if (this.widthSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.widthSlot)?.toggle()
    }
    const g = this._strokeSliderGeom()
    const thumbR = 5
    const lo = g.sld0 + thumbR
    const hi = g.sldR - thumbR
    const range = Math.max(1e-6, hi - lo)
    const v = Math.max(0, Math.min(1, (px - lo) / range))
    this._strokeWidth = Math.max(0.5, v * MAX_STROKE_WIDTH)
    this.markDirty()
  }

  private _strokeSliderHit(point: Point): boolean {
    return this._inBox(point, this._strokeSliderRowBounds())
  }

  // ----------------------------------------------------------
  // Hit testing
  // ----------------------------------------------------------

  get isInteractive(): boolean { return true }

  protected override hitTestSelf(point: Point): this | null {
    if (this._drawMode) return this

    if (this._drag !== null) return this

    if (this._drawBtnBounds !== null && this._inBox(point, this._drawBtnBounds)) return this

    if (this._strokeSliderHit(point)) return this

    const hp = this._handlePos()
    if (ptDist(point, hp.move)   <= HANDLE_HIT) return this
    if (ptDist(point, hp.scale)  <= HANDLE_HIT) return this
    if (ptDist(point, hp.rotate) <= HANDLE_HIT) return this
    return null
  }

  // ----------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------

  handlePointerDown(point: Point): boolean {
    if (this._drawBtnBounds !== null && this._inBox(point, this._drawBtnBounds)) {
      this._enterDrawMode()
      return true
    }

    if (this._drawMode) {
      this._rawPoints = [{ ...point }]
      this.markDirty()
      return true
    }

    if (this._strokeSliderHit(point)) {
      this._strokeSliderDrag = true
      this._setStrokeWidthFromPointer(point.x)
      this.markDirty()
      return true
    }

    const hp = this._handlePos()

    if (ptDist(point, hp.rotate) <= HANDLE_HIT) {
      this._suspendEndpointSlots()
      if (this.rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.rotationSlot)?.toggle()
      }
      this._drag = {
        type: 'rotate',
        center:     hp.move,
        startAngle: Math.atan2(point.y - hp.move.y, point.x - hp.move.x),
        startRot:   this._rotation,
      }
      this.markDirty()
      return true
    }

    if (ptDist(point, hp.scale) <= HANDLE_HIT) {
      this._suspendEndpointSlots()
      this._drag = {
        type:       'scale',
        center:     hp.move,
        startDist:  Math.max(1, ptDist(point, hp.move)),
        startScale: this._scale,
      }
      this.markDirty()
      return true
    }

    if (ptDist(point, hp.move) <= HANDLE_HIT) {
      this._suspendEndpointSlots()
      this._drag = {
        type:      'move',
        startMouse: { ...point },
        startCx:   this._cx,
        startCy:   this._cy,
      }
      this.markDirty()
      return true
    }

    return false
  }

  handlePointerMove(point: Point): void {
    if (this._strokeSliderDrag) {
      this._setStrokeWidthFromPointer(point.x)
      return
    }
    if (this._drawMode) {
      this._rawPoints.push({ ...point })
      this.markDirty()
      return
    }

    if (this._drag === null) return

    if (this._drag.type === 'move') {
      this._cx = this._drag.startCx + point.x - this._drag.startMouse.x
      this._cy = this._drag.startCy + point.y - this._drag.startMouse.y
    } else if (this._drag.type === 'scale') {
      const d = Math.max(1, ptDist(point, this._drag.center))
      this._scale = Math.max(0.05, this._drag.startScale * (d / this._drag.startDist))
    } else {
      // rotate
      const a = Math.atan2(point.y - this._drag.center.y, point.x - this._drag.center.x)
      this._rotation = this._drag.startRot + (a - this._drag.startAngle)
    }
    this.markDirty()
  }

  handlePointerUp(): void {
    if (this._drawMode && this._rawPoints.length >= 2) {
      this._fitBezier()
      this._hasStroke = true
      this._drawMode  = false
    }
    this._drag = null
    this._strokeSliderDrag = false
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Suspend endpoint bindings on handle drag
  // ----------------------------------------------------------

  private _suspendEndpointSlots(): void {
    if (this.startSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.startSlot)?.toggle()
    }
    if (this.endSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.endSlot)?.toggle()
    }
    // Bake computed transform into base so the stroke doesn't jump
    this._cx       = this._computedCx
    this._cy       = this._computedCy
    this._scale    = this._computedScale
    this._rotation = this._computedRotation
  }

  // ----------------------------------------------------------
  // Bézier fitting
  // ----------------------------------------------------------

  private _enterDrawMode(): void {
    this._drawMode  = true
    this._rawPoints = []
    this.markDirty()
  }

  private _fitBezier(): void {
    const pts = this._rdp(this._rawPoints, RDP_EPS)

    if (pts.length < 2) {
      const p0 = this._rawPoints[0]!, p1 = this._rawPoints[this._rawPoints.length - 1]!
      const dx = (p1.x - p0.x) / 3, dy = (p1.y - p0.y) / 3
      this._normalizeToLocal([{
        p0, cp1: { x: p0.x + dx, y: p0.y + dy },
        cp2: { x: p1.x - dx, y: p1.y - dy }, p1,
      }])
      return
    }

    const segs: Seg[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p0   = pts[i]!
      const p1   = pts[i + 1]!
      const prev = i > 0              ? pts[i - 1]! : null
      const next = i + 2 < pts.length ? pts[i + 2]! : null

      const chord = ptDist(p0, p1)
      const alpha = chord / 3

      // Catmull-Rom tangents: prev→p1 at p0, p0→next at p1
      const t0 = this._normVec(prev === null
        ? { x: p1.x - p0.x, y: p1.y - p0.y }
        : { x: p1.x - prev.x, y: p1.y - prev.y })
      const t1 = this._normVec(next === null
        ? { x: p1.x - p0.x, y: p1.y - p0.y }
        : { x: next.x - p0.x, y: next.y - p0.y })

      segs.push({
        p0,
        cp1: { x: p0.x + t0.x * alpha, y: p0.y + t0.y * alpha },
        cp2: { x: p1.x - t1.x * alpha, y: p1.y - t1.y * alpha },
        p1,
      })
    }
    this._normalizeToLocal(segs)
  }

  private _normalizeToLocal(segs: Seg[]): void {
    // Compute centroid of all endpoints
    let sumX = 0, sumY = 0, n = 0
    for (const s of segs) {
      sumX += s.p0.x + s.p1.x; sumY += s.p0.y + s.p1.y; n += 2
    }
    const cx = sumX / n, cy = sumY / n

    // Shift to local (centred at origin); record bbox half-extents for handles
    let maxX = 0, maxY = 0
    const shift = (p: Point): Point => {
      const lx = p.x - cx, ly = p.y - cy
      if (Math.abs(lx) > maxX) maxX = Math.abs(lx)
      if (Math.abs(ly) > maxY) maxY = Math.abs(ly)
      return { x: lx, y: ly }
    }

    this._localSegs = segs.map(s => ({
      p0:  shift(s.p0),
      cp1: shift(s.cp1),
      cp2: shift(s.cp2),
      p1:  shift(s.p1),
    }))
    this._renderSegs = this._localSegs

    this._cx    = cx
    this._cy    = cy
    this._scale    = 1.0
    this._rotation = 0
    this._computedCx       = cx
    this._computedCy       = cy
    this._computedScale    = 1.0
    this._computedRotation = 0
    this._localHalfW = Math.max(maxX, 1)
    this._localHalfH = Math.max(maxY, 1)
  }

  private _rdp(points: Point[], epsilon: number): Point[] {
    if (points.length <= 2) return [...points]
    const first = points[0]!, last = points[points.length - 1]!
    let maxDist = 0, maxIdx = 0
    for (let i = 1; i < points.length - 1; i++) {
      const d = this._ptLineDist(points[i]!, first, last)
      if (d > maxDist) { maxDist = d; maxIdx = i }
    }
    if (maxDist > epsilon) {
      const L = this._rdp(points.slice(0, maxIdx + 1), epsilon)
      const R = this._rdp(points.slice(maxIdx),         epsilon)
      return [...L.slice(0, -1), ...R]
    }
    return [first, last]
  }

  private _ptLineDist(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx*dx + dy*dy
    if (len2 === 0) return ptDist(p, a)
    const t = Math.max(0, Math.min(1, ((p.x - a.x)*dx + (p.y - a.y)*dy) / len2))
    return Math.hypot(p.x - a.x - t*dx, p.y - a.y - t*dy)
  }

  private _normVec(v: Point): Point {
    const len = Math.hypot(v.x, v.y)
    return len < 1e-9 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len }
  }

  // ----------------------------------------------------------
  // Handle positions (ImageLayer style)
  // ----------------------------------------------------------

  private _handlePos() {
    const cos = Math.cos(this._computedRotation), sin = Math.sin(this._computedRotation)
    const cx  = this._computedCx
    const cy  = this._computedCy
    const shx = this._localHalfW * this._computedScale
    const shy = this._localHalfH * this._computedScale
    return {
      move:   { x: cx, y: cy },
      scale:  { x: cx + shx * cos - shy * sin, y: cy + shx * sin + shy * cos },
      rotate: { x: cx + ROT_ARM * sin,          y: cy - ROT_ARM * cos },
    }
  }

  // ----------------------------------------------------------
  // Panel drawing
  // ----------------------------------------------------------

  private _drawPill(ctx: Ctx2D, b: BBox): void {
    const { x, y, width, height } = b
    if (width <= 0 || height <= 0) return

    const midY = y + height / 2
    const c    = this._colour

    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    ctx.fillStyle = `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},${c.a})`
    ctx.beginPath()
    ctx.arc(x + 16, midY, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth   = 1
    ctx.stroke()

    ctx.font         = '11px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      this._drawMode
        ? 'Stroke  ✎ drawing…'
        : `Stroke  ${this._localSegs.length} seg  ${Math.round(this._strokeWidth)}px`,
      x + 28, midY,
    )

    // Draw / Done button (canvas-space pill only)
    if (width >= panelWidth(Node.canvasWidth)) {
      const BTN_W = 44, BTN_H = height - 8
      const btnX  = x + width - BTN_W - 4, btnY = y + 4
      this._drawBtnBounds = { x: btnX, y: btnY, width: BTN_W, height: BTN_H }

      ctx.fillStyle = this._drawMode ? ACCENT + '44' : 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      ctx.roundRect(btnX, btnY, BTN_W, BTN_H, 3)
      ctx.fill()
      ctx.strokeStyle = this._drawMode ? ACCENT + 'cc' : 'rgba(255,255,255,0.30)'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.roundRect(btnX + 0.5, btnY + 0.5, BTN_W - 1, BTN_H - 1, 3)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      ctx.textAlign = 'center'
      ctx.fillText(this._drawMode ? 'done' : '✎ draw', btnX + BTN_W / 2, midY)
    } else {
      this._drawBtnBounds = null
    }

    ctx.restore()
  }

  private _renderHandles(ctx: Ctx2D): void {
    const hp = this._handlePos()
    const startActive = this.startSlot.state !== SlotState.Unbound
    const endActive   = this.endSlot.state   !== SlotState.Unbound

    ctx.save()

    // Dashed arm lines
    ctx.strokeStyle = 'rgba(255,255,255,0.38)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y); ctx.lineTo(hp.rotate.x, hp.rotate.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(hp.move.x, hp.move.y); ctx.lineTo(hp.scale.x, hp.scale.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Scale handle — square, cyan (dimmed if endpoints are bound)
    this._drawGlowSquare(ctx, hp.scale, HANDLE_SZ,
      (startActive || endActive) ? '#446688' : '#81d4fa')

    // Rotate handle — circle, orange (dimmed if rotationSlot is bound)
    this._drawGlowCircle(ctx, hp.rotate, HANDLE_R,
      this.rotationSlot.isActive ? '#446688' : '#ffb74d')

    // Move handle — circle+crosshair (dimmed if endpoints are bound)
    const moveColour = (startActive || endActive) ? '#446688' : '#ffffff'
    this._drawGlowCircle(ctx, hp.move, HANDLE_R, moveColour)
    const cr = HANDLE_R - 2
    ctx.strokeStyle = 'rgba(0,0,0,0.80)'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.moveTo(hp.move.x - cr, hp.move.y); ctx.lineTo(hp.move.x + cr, hp.move.y)
    ctx.moveTo(hp.move.x, hp.move.y - cr); ctx.lineTo(hp.move.x, hp.move.y + cr)
    ctx.stroke()

    ctx.restore()
  }

  private _drawGlowCircle(ctx: Ctx2D, pt: Point, r: number, glow: string): void {
    ctx.save()
    ctx.shadowColor = glow; ctx.shadowBlur = 14
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill()
    ctx.restore()
    ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 1.5; ctx.stroke()
  }

  private _drawGlowSquare(ctx: Ctx2D, pt: Point, s: number, glow: string): void {
    ctx.save()
    ctx.shadowColor = glow; ctx.shadowBlur = 14
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.fillRect(pt.x - s, pt.y - s, s * 2, s * 2)
    ctx.restore()
    ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 1.5
    ctx.strokeRect(pt.x - s, pt.y - s, s * 2, s * 2)
  }

  private _inBox(p: Point, b: BBox): boolean {
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  }
}
