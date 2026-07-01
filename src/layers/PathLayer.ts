import { ShapeLayer } from './ShapeLayer.js'
import { Node } from '../core/Node.js'
import {
  ValueType,
  SlotState,
  boundingBoxContains,
  type Colour,
  type Point,
  type PointSource,
  type DirectionSource,
  type Direction,
  type AmountSource,
  type Ctx2D,
} from '../core/types.js'
import { BindingLayer } from './BindingLayer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import { collectSnapEdges, snapPointToEdges, drawSnapGuides, EDGE_SNAP_THRESHOLD } from '../interaction/EdgeSnapper.js'
import {
  hashString,
  drawPencilLine, drawNibPen,       NIB_PEN_DEFAULTS,
  drawCalligraphyBrush,             BRUSH_DEFAULTS,
  drawNibBrushBlend,
  drawLichtensteinStroke,
} from './artisticBrush.js'

// ------------------------------------------------------------
// PathLayer — a closed Catmull-Rom spline shape layer
// ------------------------------------------------------------
//
// Extends ShapeLayer so it shares the same slot set, rendering
// pipeline, and type identity as Rect and Ellipse.
//
// drawShape    — renders the spline fill (called by ShapeLayer.renderSelf)
// samplePerimeter — samples a point on the spline at t ∈ [0, 1)
// renderPanel  — overrides to show spline control-point handles
//                instead of the bbox handles used by Rect/Ellipse

// ------------------------------------------------------------------
// Catmull-Rom spline (Hermite form with parameterised handle length)
// ------------------------------------------------------------------
// r = 0    → straight line segments between control points
// r = 0.5  → standard Catmull-Rom (tangent = 0.5*(P2-P0))
// r > 0.5  → extended handles; can produce loops

function catmullRom(P0: Point, P1: Point, P2: Point, P3: Point, t: number, r: number): Point {
  const t2 = t * t, t3 = t2 * t
  return {
    x: (-r*P0.x + (2-r)*P1.x + (r-2)*P2.x + r*P3.x)*t3
     + (2*r*P0.x + (r-3)*P1.x + (3-2*r)*P2.x - r*P3.x)*t2
     + r*(-P0.x + P2.x)*t
     + P1.x,
    y: (-r*P0.y + (2-r)*P1.y + (r-2)*P2.y + r*P3.y)*t3
     + (2*r*P0.y + (r-3)*P1.y + (3-2*r)*P2.y - r*P3.y)*t2
     + r*(-P0.y + P2.y)*t
     + P1.y,
  }
}

function samplePath(points: Point[], t: number, r: number): Point {
  const n = points.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return { ...points[0]! }
  const t0 = ((t % 1) + 1) % 1
  const fi = t0 * n
  const i  = Math.floor(fi)
  const u  = fi - i
  return catmullRom(
    points[(i - 1 + n) % n]!,
    points[i % n]!,
    points[(i + 1) % n]!,
    points[(i + 2) % n]!,
    u,
    r,
  )
}

// Open (non-wrapping) Catmull-Rom: t ∈ [0,1] maps over n-1 segments.
// Boundary points are clamped (first/last control point repeated as phantom).
export function samplePathOpen(points: Point[], t: number, r: number): Point {
  const n = points.length
  if (n === 0) return { x: 0, y: 0 }
  if (n === 1) return { ...points[0]! }
  const clamped = Math.max(0, Math.min(1, t))
  if (clamped >= 1) return { ...points[n - 1]! }
  const fi = clamped * (n - 1)
  const i  = Math.min(Math.floor(fi), n - 2)
  const u  = fi - i
  const P0 = i > 0     ? points[i - 1]! : points[0]!
  const P1 = points[i]!
  const P2 = points[i + 1]!
  const P3 = i + 2 < n ? points[i + 2]! : points[n - 1]!
  return catmullRom(P0, P1, P2, P3, u, r)
}

function rotatePoint(p: Point, c: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = p.x - c.x, dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

function defaultPoints(cx: number, cy: number): Point[] {
  const rx = 130, ry = 85, n = 6
  const avgR = (rx + ry) / 2
  const angleStep = (Math.PI * 2) / n
  // Angular jitter stays well under half a step so neighbouring points
  // can never swap order — guarantees a simple (non-self-crossing) polygon.
  const angleJitter  = angleStep * 0.35
  // Radius jitter stays within ~40% of the average radius — no spikes
  // or dents far beyond the nominal outline.
  const radiusJitter = avgR * 0.4
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 + (Math.random() * 2 - 1) * angleJitter
    const rScale = 1 + (Math.random() * 2 - 1) * (radiusJitter / avgR)
    return { x: cx + rx * rScale * Math.cos(a), y: cy + ry * rScale * Math.sin(a) }
  })
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const ACCENT     = '#e8a04a'
const DIR_ACCENT = '#7ecfcf'
const AM_COL     = '#4a8fe8'
const CP_R       = 6
const HIT_R      = 14
const ROT_OFF    = 24
const SAMPLES    = 200
const MIN_POINTS = 3   // smallest closed spline we allow (a triangle)

// Brush case thresholds — identical to StrokeLayer
const BRUSH_TRANSITIONS = [5, 13, 25] as const
const BRUSH_BLEND_HW    = 2
const BRUSH_OFFSETS     = [0, 0, 3, 5, 11]
const BRUSH_SAMPLES     = 200

// Radius slider geometry — mirrors ShapeLayer's stroke-width pill layout
const SLOT_H      = 30
const SLOT_GAP    = 4
const MAX_RADIUS  = 0.8   // slider maps [0, MAX_RADIUS]
const RAD_LABEL_W = 78
const RAD_VALUE_W = 38

// ------------------------------------------------------------------
// PathLayer
// ------------------------------------------------------------------

export class PathLayer extends ShapeLayer {
  // types inherited from ShapeLayer: Set([ValueType.Point])

  protected _points:        Point[]
  private _dragIndex:       number = -1
  private _specialDrag:     'center' | 'size' | 'rotate' | null = null
  private _dragStartPtr:    Point = { x: 0, y: 0 }
  private _dragStartPts:    Point[] = []
  private _dragStartCenter: Point = { x: 0, y: 0 }
  private _dragStartAngle:  number = 0

  protected _radius          = 0.5
  private _radiusSliderDrag = false
  readonly radiusSlot:     ParameterSlot

  // Edge snap guide lines (set during move/point drags, cleared on pointer-up)
  private _pathEdgeSnapX: number | null = null
  private _pathEdgeSnapY: number | null = null

  // true = closed Catmull-Rom loop; false = open spline (StrokeLayer).
  protected _closedPath = true

  // Cached brush rendering — rebuilt in recompute, blitted in renderSelf
  private _brushCanvas: OffscreenCanvas = new OffscreenCanvas(1, 1)

  // Subclasses override this getter to change the minimum point count.
  protected get _minPoints(): number { return MIN_POINTS }

  // Hook called at the start of every canvas-space handle drag (center, size,
  // rotate, or individual control point). Subclasses override to suspend slots.
  protected _onHandleDragStart(): void {}

  constructor(points?: Point[], cx = 500, cy = 300, colour?: Colour) {
    // Pass dummy w/h — PathLayer geometry is defined by control points, not bbox.
    super(cx, cy, 1, 1, colour)
    this._points    = points ?? defaultPoints(cx, cy)
    this.radiusSlot = new ParameterSlot(ValueType.Amount, this, 'spline radius')
    this.slots.push(this.radiusSlot)
  }

  override getSnapBounds() {
    if (this._points.length === 0) return null
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of this._points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
    }
    return { minX, maxX, minY, maxY }
  }

  // ----------------------------------------------------------
  // Node — slot-driven rotation and position are applied to the
  // control points directly (PathLayer has no separate
  // width/height/centre render transform), then super.recompute()
  // resolves `_angle`/`_cx`/`_cy` to match.
  // ----------------------------------------------------------

  protected override recompute(): void {
    if (this.radiusSlot.isActive) {
      this._radius = (this.radiusSlot.source as AmountSource).getAmount() * MAX_RADIUS
    }
    if (this.rotationSlot.isActive) {
      const newAngle = (this.rotationSlot.source as DirectionSource).getDirection().angle
      const delta = newAngle - this._angle
      if (delta !== 0) {
        const c = this._centroid()
        this._points = this._points.map(p => rotatePoint(p, c, delta))
      }
    }
    if (this.positionSlot.isActive) {
      const p = (this.positionSlot.source as PointSource).getPoint()
      const c = this._centroid()
      const dx = p.x - c.x
      const dy = p.y - c.y
      if (dx !== 0 || dy !== 0) {
        this._points = this._points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }))
      }
    }
    super.recompute()
    this._rebuildBrushCanvas()
  }

  private _rebuildBrushCanvas(): void {
    const w = Node.canvasWidth, h = Node.canvasHeight
    if (this._brushCanvas.width !== w || this._brushCanvas.height !== h)
      this._brushCanvas = new OffscreenCanvas(w, h)
    const bctx = this._brushCanvas.getContext('2d')!
    bctx.clearRect(0, 0, w, h)
    if (this._filled || this._points.length < 2) return
    const c   = this._scale !== 1 ? this._centroid() : null
    const pts: Point[] = []
    for (let i = 0; i <= BRUSH_SAMPLES; i++) {
      const t = i / BRUSH_SAMPLES
      let p = samplePath(this._points, t % 1, this._radius)
      if (c !== null) p = { x: c.x + (p.x - c.x) * this._scale, y: c.y + (p.y - c.y) * this._scale }
      pts.push(p)
    }
    const sz   = this._strokeWidth
    const col0 = this._colour
    const col  = `#${Math.round(col0.r*255).toString(16).padStart(2,'0')}${Math.round(col0.g*255).toString(16).padStart(2,'0')}${Math.round(col0.b*255).toString(16).padStart(2,'0')}`
    const seed = hashString(this.debugName)
    const [pt0, pt1, pt2] = BRUSH_TRANSITIONS
    const hw = BRUSH_BLEND_HW
    if (sz > pt1 - hw && sz < pt1 + hw) {
      const t   = (sz - (pt1 - hw)) / (2 * hw)
      const eff = Math.max(1, sz - ((1 - t) * (BRUSH_OFFSETS[2] ?? 0) + t * (BRUSH_OFFSETS[3] ?? 0)))
      drawNibBrushBlend(bctx, pts, col, eff, seed, NIB_PEN_DEFAULTS, BRUSH_DEFAULTS, t)
    } else {
      const caseIdx = sz < pt0 ? 1 : sz < pt1 ? 2 : sz < pt2 ? 3 : 4
      const eff = Math.max(1, sz - (BRUSH_OFFSETS[caseIdx] ?? 0))
      switch (caseIdx) {
        case 1: drawPencilLine(bctx,         pts, col, eff, seed); break
        case 2: drawNibPen(bctx,             pts, col, eff, seed); break
        case 3: drawCalligraphyBrush(bctx,   pts, col, eff, seed); break
        case 4: drawLichtensteinStroke(bctx, pts, col, eff, seed); break
      }
    }
  }

  // ----------------------------------------------------------
  // State snapshot — used by StrokeLayer.convertToPath
  // ----------------------------------------------------------

  /** Copy externally-supplied scalar state into this layer's fields.
   *  Called when converting a StrokeLayer to a closed PathLayer. */
  applyStateSnapshot(snap: {
    colour: Colour; opacity: number; scale: number
    radius: number; strokeWidth: number; filled: boolean
  }): void {
    this._colour      = { ...snap.colour }
    this._opacity     = snap.opacity
    this._scale       = snap.scale
    this._radius      = snap.radius
    this._strokeWidth = snap.strokeWidth
    this._filled      = snap.filled
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return { ...super.serializeState(), points: this._points, radius: this._radius }
  }

  override deserializeState(state: Record<string, unknown>): void {
    super.deserializeState(state)
    if (Array.isArray(state.points))        this._points = state.points as Point[]
    if (typeof state.radius === 'number')   this._radius = state.radius
  }

  override getSlotDefault(slot: ParameterSlot): Point | number | Direction | Colour | null {
    if (slot === this.positionSlot) return { ...this._centroid() }
    if (slot === this.radiusSlot)   return Math.max(0, Math.min(1, this._radius / MAX_RADIUS))
    return super.getSlotDefault(slot)
  }

  // ----------------------------------------------------------
  // ShapeLayer contract
  // ----------------------------------------------------------

  /** Draw the spline. Called by ShapeLayer.renderSelf. */
  protected drawShape(
    ctx: Ctx2D,
    _cx: number, _cy: number,
    _w: number, _h: number,
    _angle: number,
    colour: Colour,
    opacity: number,
    filled: boolean,
    strokeWidth: number,
  ): void {
    if (this._points.length < 2) return
    const css = `rgba(${Math.round(colour.r*255)},${Math.round(colour.g*255)},${Math.round(colour.b*255)},${colour.a})`
    ctx.save()
    ctx.globalAlpha = opacity

    if (this._scale !== 1) {
      const c = this._centroid()
      ctx.translate(c.x, c.y)
      ctx.scale(this._scale, this._scale)
      ctx.translate(-c.x, -c.y)
    }

    ctx.beginPath()
    for (let i = 0; i <= SAMPLES; i++) {
      const t  = i / SAMPLES
      const pt = this._closedPath
        ? samplePath(this._points, t % 1, this._radius)
        : samplePathOpen(this._points, t, this._radius)
      if (i === 0) ctx.moveTo(pt.x, pt.y)
      else         ctx.lineTo(pt.x, pt.y)
    }
    if (this._closedPath) ctx.closePath()
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

  /** Sample a point on the spline perimeter. */
  samplePerimeter(t: number): Point {
    const p = this._closedPath
      ? samplePath(this._points, t, this._radius)
      : samplePathOpen(this._points, Math.max(0, Math.min(1, t)), this._radius)
    if (this._scale === 1) return p
    const c = this._centroid()
    return { x: c.x + (p.x - c.x) * this._scale, y: c.y + (p.y - c.y) * this._scale }
  }

  // ----------------------------------------------------------
  // Slot rendering — radius pill appended below the stroke pill
  // ----------------------------------------------------------

  // Override to exclude radiusSlot from the standard-slot count so the
  // stroke pill is positioned correctly when computing standardH.
  protected override _strokePillBounds() {
    const cb = this.canvasBounds
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot && s !== this.scaleSlot && s !== this.radiusSlot
    )
    const standardH = standardSlots.length * (SLOT_H + SLOT_GAP) - SLOT_GAP
    return { x: cb.x, y: this.panelBottom + standardH + 8, width: cb.width, height: 5 * SLOT_H + 4 * SLOT_GAP }
  }

  override renderSlots(ctx: Ctx2D): void {
    this._slotBounds.clear()
    const standardSlots = this.slots.filter(
      s => s !== this.fillModeSlot && s !== this.strokeWidthSlot && s !== this.scaleSlot && s !== this.radiusSlot
    )
    this.renderSlotGroup(ctx, standardSlots, this.panelBottom)
    this._drawStrokePill(ctx)
    this._drawRadiusPill(ctx)
  }

  private _radiusPillBounds() {
    const spb = this._strokePillBounds()
    const cb  = this.canvasBounds
    return { x: cb.x, y: spb.y + spb.height + 8, width: cb.width, height: 2 * SLOT_H + SLOT_GAP }
  }

  private _radiusRowBounds() {
    const pb = this._radiusPillBounds()
    return { x: pb.x, y: pb.y, width: pb.width, height: SLOT_H }
  }

  private _radiusBindRowBounds() {
    const pb = this._radiusPillBounds()
    return { x: pb.x, y: pb.y + SLOT_H + SLOT_GAP, width: pb.width, height: SLOT_H }
  }

  private _radiusSliderGeom() {
    const b = this._radiusRowBounds()
    const midY       = b.y + b.height / 2
    const labelX     = b.x + 12
    const indX       = b.x + b.width - 8
    const valueRight = indX - 14
    const sld0       = labelX + RAD_LABEL_W
    const sldR       = valueRight - RAD_VALUE_W - 6
    return { b, midY, labelX, sld0, sldR, valueRight, indX }
  }

  private _radiusSliderHit(point: Point): boolean {
    return boundingBoxContains(this._radiusRowBounds(), point)
  }

  private _setRadiusFromPointer(px: number): void {
    if (this.radiusSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.radiusSlot)?.toggle()
    }
    const g = this._radiusSliderGeom()
    const thumbR = 5
    const lo     = g.sld0 + thumbR
    const hi     = g.sldR - thumbR
    const range  = Math.max(1e-6, hi - lo)
    this._radius = Math.max(0, Math.min(1, (px - lo) / range)) * MAX_RADIUS
    this.markDirty()
  }

  protected _drawRadiusPill(ctx: Ctx2D): void {
    const rRow = this._radiusRowBounds()
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.roundRect(rRow.x, rRow.y, rRow.width, 2 * SLOT_H + SLOT_GAP, 6)
    ctx.fill()
    ctx.restore()
    this._drawRadiusSlider(ctx, false)
    this._renderBindingRow(ctx, this.radiusSlot, this._radiusBindRowBounds().y)
  }

  private _drawRadiusSlider(ctx: Ctx2D, drawBackdrop = true): void {
    const g = this._radiusSliderGeom()
    const { x, y, width, height } = g.b

    const active = this.radiusSlot.isActive
    const colour = active ? AM_COL : ACCENT
    const v01    = Math.max(0, Math.min(1, this._radius / MAX_RADIUS))

    ctx.save()

    if (drawBackdrop) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, 6)
      ctx.fill()
    }

    ctx.font         = '10px monospace'
    ctx.fillStyle    = 'rgba(255,255,255,0.62)'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('spline radius', g.labelX, g.midY)

    this._drawSlider(ctx, g.midY, g.sld0, g.sldR, v01, colour)

    ctx.font      = '10px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.90)'
    ctx.textAlign = 'right'
    ctx.fillText(this._radius.toFixed(2), g.valueRight, g.midY)

    ctx.font      = '9px monospace'
    ctx.fillStyle = active ? AM_COL : 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText(active ? '●' : '○', g.indX, g.midY)

    ctx.restore()
  }

  // ----------------------------------------------------------
  // Rendering — override to show spline handles, not bbox handles
  // ----------------------------------------------------------

  override renderPanel(ctx: Ctx2D): void {
    this._drawPill(ctx, this.bounds)
    this._drawPill(ctx, this.canvasBounds)
  }

  override renderOverlay(ctx: Ctx2D): void {
    this._drawControlHandles(ctx)
    drawSnapGuides(ctx, this._pathEdgeSnapX, this._pathEdgeSnapY, Node.canvasWidth, Node.canvasHeight)
    this._renderConvBtn(ctx, 'animate')
    this._renderConvBtn(ctx, 'mask')
  }

  // ----------------------------------------------------------
  // Hit testing — control points instead of bbox handles
  // ----------------------------------------------------------

  protected override hitTestSelf(point: Point): this | null {
    if (this._convBtnHitTest(point, 'animate')) return this
    if (this._convBtnHitTest(point, 'mask'))    return this
    // Canvas-space handles take priority over pill controls.
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) return this
    const sh = this._sizeHandlePos()
    if ((point.x - sh.x) ** 2 + (point.y - sh.y) ** 2 <= r2) return this
    const rh = this._rotateHandlePos()
    if ((point.x - rh.x) ** 2 + (point.y - rh.y) ** 2 <= r2) return this
    if (this._nearest(point) >= 0) return this
    if (this._curveHit(point) !== null) return this
    // Pill controls
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) return this
    }
    if (this._strokeSliderHit(point)) return this
    if (this._scaleSliderHit(point))  return this
    if (this._radiusSliderHit(point)) return this
    return null
  }

  override handlePointerDown(point: Point): boolean {
    if (this._convBtnHitTest(point, 'animate')) {
      this._addAnimateDone = true
      this._onAddAnimate?.()
      return true
    }
    if (this._convBtnHitTest(point, 'mask')) {
      this._addMaskDone = true
      this._onAddMask?.()
      return true
    }
    // Canvas-space handles take priority over pill controls.
    const r2 = HIT_R * HIT_R
    const c  = this._centroid()
    if ((point.x - c.x) ** 2 + (point.y - c.y) ** 2 <= r2) {
      if (this.positionSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.positionSlot)?.toggle()
      }
      this._onHandleDragStart()
      this._specialDrag     = 'center'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this._dragStartCenter = c
      this.markDirty()
      return true
    }
    const sh = this._sizeHandlePos()
    if ((point.x - sh.x) ** 2 + (point.y - sh.y) ** 2 <= r2) {
      this._onHandleDragStart()
      this._specialDrag     = 'size'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this._dragStartCenter = c
      this.markDirty()
      return true
    }
    const rh = this._rotateHandlePos()
    if ((point.x - rh.x) ** 2 + (point.y - rh.y) ** 2 <= r2) {
      if (this.rotationSlot.state === SlotState.Bound) {
        BindingLayer.findForSlot(this.rotationSlot)?.toggle()
      }
      this._onHandleDragStart()
      this._specialDrag     = 'rotate'
      this._dragStartPtr    = { ...point }
      this._dragStartPts    = this._points.map(p => ({ ...p }))
      this._dragStartCenter = c
      this._dragStartAngle  = this._angle
      this.markDirty()
      return true
    }
    const idx = this._nearest(point)
    if (idx >= 0) {
      this._onHandleDragStart()
      this._dragIndex = idx
      this.markDirty()
      return true
    }
    // Click on the spline outline itself: insert a new control point
    // exactly on the current curve, so the shape is unchanged until the
    // new point is dragged.
    const hit = this._curveHit(point)
    if (hit !== null) {
      this._onHandleDragStart()
      this._points.splice(hit.insertAt, 0, { ...hit.pos })
      this._dragIndex = hit.insertAt
      this.markDirty()
      return true
    }
    // Pill controls
    if (this._toggleBounds !== null) {
      const b = this._toggleBounds
      if (point.x >= b.x && point.x <= b.x + b.width &&
          point.y >= b.y && point.y <= b.y + b.height) {
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
    }
    if (this._strokeSliderHit(point)) {
      this._strokeSliderDrag = true
      this._setStrokeWidthFromPointer(point.x)
      this.markDirty()
      return true
    }
    if (this._scaleSliderHit(point)) {
      this._scaleSliderDrag = true
      this._setScaleFromPointer(point.x)
      this.markDirty()
      return true
    }
    if (this._radiusSliderHit(point)) {
      this._radiusSliderDrag = true
      this._setRadiusFromPointer(point.x)
      this.markDirty()
      return true
    }
    return false
  }

  /** Right-click on a control point removes it. */
  handleContextMenu(point: Point): boolean {
    if (this._points.length <= this._minPoints) return false
    const idx = this._nearest(point)
    if (idx < 0) return false
    this._points.splice(idx, 1)
    if (this._dragIndex === idx) this._dragIndex = -1
    this.markDirty()
    return true
  }

  override startCenterDrag(point: Point): boolean {
    if (this.positionSlot.state === SlotState.Bound) {
      BindingLayer.findForSlot(this.positionSlot)?.toggle()
    }
    this._onHandleDragStart()
    this._specialDrag     = 'center'
    this._dragStartPtr    = { ...point }
    this._dragStartPts    = this._points.map(p => ({ ...p }))
    this._dragStartCenter = this._centroid()
    this.markDirty()
    return true
  }

  override handlePointerMove(point: Point): void {
    if (this._strokeSliderDrag) {
      this._setStrokeWidthFromPointer(point.x)
      return
    }
    if (this._scaleSliderDrag) {
      this._setScaleFromPointer(point.x)
      return
    }
    if (this._radiusSliderDrag) {
      this._setRadiusFromPointer(point.x)
      return
    }
    if (this._specialDrag === 'center') {
      const rawDx = point.x - this._dragStartPtr.x
      const rawDy = point.y - this._dragStartPtr.y
      const rawCentroid = { x: this._dragStartCenter.x + rawDx, y: this._dragStartCenter.y + rawDy }
      const edges = collectSnapEdges(this, 3)
      let snappedDx = rawDx, snappedDy = rawDy
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const b  = this.getSnapBounds() ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 }
        const offX = (b.maxX - b.minX) / 2, offY = (b.maxY - b.minY) / 2
        const snapped = snapPointToEdges(rawCentroid, edges, EDGE_SNAP_THRESHOLD,
          [-offX, 0, offX], [-offY, 0, offY],
        )
        snappedDx = snapped.x - this._dragStartCenter.x
        snappedDy = snapped.y - this._dragStartCenter.y
        this._pathEdgeSnapX = snapped.snapLineX; this._pathEdgeSnapY = snapped.snapLineY
      } else {
        this._pathEdgeSnapX = null; this._pathEdgeSnapY = null
      }
      this._points = this._dragStartPts.map(p => ({ x: p.x + snappedDx, y: p.y + snappedDy }))
      this.markDirty()
      return
    }
    if (this._specialDrag === 'size') {
      const c0   = this._dragStartCenter
      const d0   = Math.hypot(this._dragStartPtr.x - c0.x, this._dragStartPtr.y - c0.y)
      const d1   = Math.hypot(point.x - c0.x, point.y - c0.y)
      const scale = d0 > 0 ? d1 / d0 : 1
      this._points = this._dragStartPts.map(p => ({
        x: c0.x + (p.x - c0.x) * scale,
        y: c0.y + (p.y - c0.y) * scale,
      }))
      this.markDirty()
      return
    }
    if (this._specialDrag === 'rotate') {
      const c0 = this._dragStartCenter
      const a0 = Math.atan2(this._dragStartPtr.y - c0.y, this._dragStartPtr.x - c0.x)
      const a1 = Math.atan2(point.y - c0.y, point.x - c0.x)
      const delta = a1 - a0
      this._points = this._dragStartPts.map(p => rotatePoint(p, c0, delta))
      this._angle  = this._dragStartAngle + delta
      this.markDirty()
      return
    }
    if (this._dragIndex >= 0) {
      const edges = collectSnapEdges(this, 3)
      if (edges.xs.length > 0 || edges.ys.length > 0) {
        const snapped = snapPointToEdges(point, edges, EDGE_SNAP_THRESHOLD)
        this._points[this._dragIndex] = { x: snapped.x, y: snapped.y }
        this._pathEdgeSnapX = snapped.snapLineX; this._pathEdgeSnapY = snapped.snapLineY
      } else {
        this._points[this._dragIndex] = { ...point }
        this._pathEdgeSnapX = null; this._pathEdgeSnapY = null
      }
      this.markDirty()
    }
  }

  override handlePointerUp(): void {
    this._specialDrag      = null
    this._dragIndex        = -1
    this._strokeSliderDrag = false
    this._scaleSliderDrag  = false
    this._radiusSliderDrag = false
    this._pathEdgeSnapX    = null
    this._pathEdgeSnapY    = null
    this.markDirty()
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  protected _centroid(): Point {
    if (this._points.length === 0) return { x: 0, y: 0 }
    const x = this._points.reduce((s, p) => s + p.x, 0) / this._points.length
    const y = this._points.reduce((s, p) => s + p.y, 0) / this._points.length
    return { x, y }
  }

  private _sizeHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._points.reduce((r, p) => Math.max(r, Math.hypot(p.x - c.x, p.y - c.y)), 0)
    return { x: c.x + maxR + 24, y: c.y }
  }

  /** Rotate handle — orbits the centroid, tracking `_angle`. */
  private _rotateHandlePos(): Point {
    const c    = this._centroid()
    const maxR = this._points.reduce((r, p) => Math.max(r, Math.hypot(p.x - c.x, p.y - c.y)), 0)
    const a    = this._angle - Math.PI / 2
    return { x: c.x + (maxR + ROT_OFF) * Math.cos(a), y: c.y + (maxR + ROT_OFF) * Math.sin(a) }
  }

  private _nearest(p: Point): number {
    const r2 = HIT_R * HIT_R
    let best = -1, bestD = Infinity
    for (let i = 0; i < this._points.length; i++) {
      const cp = this._points[i]!
      const d2 = (p.x - cp.x) ** 2 + (p.y - cp.y) ** 2
      if (d2 <= r2 && d2 < bestD) { bestD = d2; best = i }
    }
    return best
  }

  /**
   * Test whether `p` lies on the spline outline (within HIT_R) and, if so,
   * return where a new control point should be inserted: the index to
   * splice at, and the on-curve position to give it (so the shape is
   * visually unchanged until that point is dragged).
   */
  private _curveHit(p: Point): { insertAt: number; pos: Point } | null {
    const n = this._points.length
    if (n < 2) return null
    const r2 = HIT_R * HIT_R
    let bestT = 0, bestD2 = Infinity, bestPos: Point = { x: 0, y: 0 }
    for (let i = 0; i <= SAMPLES; i++) {
      const t  = i / SAMPLES
      const pt = this._closedPath
        ? samplePath(this._points, t % 1, this._radius)
        : samplePathOpen(this._points, t, this._radius)
      const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2
      if (d2 < bestD2) { bestD2 = d2; bestT = t; bestPos = pt }
    }
    if (bestD2 > r2) return null
    const segIndex = this._closedPath
      ? Math.min(n - 1, Math.floor(bestT * n))
      : Math.min(n - 2, Math.floor(bestT * (n - 1)))
    return { insertAt: segIndex + 1, pos: bestPos }
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
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
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = 'rgba(255,255,255,0.80)'
    ctx.textAlign    = 'left'
    ctx.fillText(`${this._points.length} pts`, x + 28, midY)

    // Angle (right side), with rotation-slot indicator dot
    const deg = ((this._angle * 180 / Math.PI) % 360 + 360) % 360
    const rotActive = this.rotationSlot.isActive
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.50)'
    ctx.textAlign = 'right'
    ctx.fillText(`∠ ${deg.toFixed(0)}°`, x + width - 8, midY)
    const angleW = ctx.measureText(`∠ ${deg.toFixed(0)}°`).width
    ctx.fillStyle = rotActive ? DIR_ACCENT : 'rgba(255,255,255,0.22)'
    ctx.font = '9px monospace'
    ctx.fillText(rotActive ? '●' : '○', x + width - 12 - angleW, midY)

    ctx.restore()
  }

  // Suppress orange spline outline in stroke mode — brush rendering is the visual.
  protected _showSplineGuide(): boolean { return this._filled }

  override renderSelf(ctx: Ctx2D): void {
    if (this._filled) {
      super.renderSelf(ctx)
    } else {
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, this._opacity * this._colour.a))
      ctx.drawImage(this._brushCanvas, 0, 0)
      ctx.restore()
    }
  }

  private _drawControlHandles(ctx: Ctx2D): void {
    if (this._points.length < 2) return
    const c  = this._centroid()
    const sh = this._sizeHandlePos()
    const rh = this._rotateHandlePos()

    ctx.save()

    // Spline outline (edit-mode overlay) — suppressed in artistic brush mode
    if (this._showSplineGuide()) {
      ctx.beginPath()
      for (let i = 0; i <= SAMPLES; i++) {
        const t  = i / SAMPLES
        const pt = this._closedPath
          ? samplePath(this._points, t % 1, this._radius)
          : samplePathOpen(this._points, t, this._radius)
        if (i === 0) ctx.moveTo(pt.x, pt.y)
        else         ctx.lineTo(pt.x, pt.y)
      }
      if (this._closedPath) ctx.closePath()
      ctx.strokeStyle = 'rgba(232,160,74,0.70)'
      ctx.lineWidth   = 1.5
      ctx.setLineDash([])
      ctx.stroke()
    }

    // Dashed line from centre to size handle
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(sh.x, sh.y)
    ctx.stroke()

    // Dashed line from centre to rotate handle
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(rh.x, rh.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Control point handles
    for (let i = 0; i < this._points.length; i++) {
      const pt  = this._points[i]!
      const lit = i === this._dragIndex
      ctx.fillStyle   = lit ? ACCENT : 'rgba(232,160,74,0.30)'
      ctx.strokeStyle = lit ? '#ffffff' : ACCENT
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, CP_R, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // Centre handle (amber filled circle)
    const litC = this._specialDrag === 'center'
    ctx.fillStyle   = litC ? '#ffffff' : ACCENT
    ctx.strokeStyle = litC ? ACCENT : 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.arc(c.x, c.y, CP_R + 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    // Size handle (white square)
    const litS = this._specialDrag === 'size'
    const hs   = CP_R
    ctx.fillStyle   = litS ? ACCENT : 'rgba(255,255,255,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.fillRect(sh.x - hs, sh.y - hs, hs * 2, hs * 2)
    ctx.strokeRect(sh.x - hs, sh.y - hs, hs * 2, hs * 2)

    // Rotate handle (circle, dimmed when rotationSlot is active)
    const litR = this._specialDrag === 'rotate'
    ctx.fillStyle = litR ? '#ffffff'
      : this.rotationSlot.isActive ? 'rgba(102,102,136,0.85)' : 'rgba(232,160,74,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.arc(rh.x, rh.y, CP_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    ctx.restore()
  }
}
