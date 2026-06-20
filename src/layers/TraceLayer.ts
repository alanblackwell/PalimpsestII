import { Layer }         from '../core/Layer.js'
import { ParameterSlot } from '../core/ParameterSlot.js'
import {
  ValueType,
  boundingBoxContains,
  type Amount, type AmountSource,
  type ImageSource,
  type MaskValue, type MaskSource,
  type Point, type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }          from '../dataflow/Graph.js'
import { SliderRegion }   from '../regions/SliderRegion.js'
import { detectContour }  from './contourTrace.js'

// ------------------------------------------------------------
// TraceLayer — closed path traced from the boundary of a mask
// (or, when no mask is supplied, the largest connected region in
// a thresholded grayscale image).
// ------------------------------------------------------------
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
// Inputs:
//   imageSlot (Image)  — source bitmap
//   maskSlot  (Mask)   — optional; preferred shape source
//   phaseSlot (Amount) — position along perimeter [0, 1]

const ACCENT     = '#cf9f7e'
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

// ── Geometry helpers ────────────────────────────────────────────

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
  const p0=pts[(i-1+n)%n], p1=pts[i], p2=pts[(i+1)%n], p3=pts[(i+2)%n]
  return { x: catmullRom(u,p0.x,p1.x,p2.x,p3.x), y: catmullRom(u,p0.y,p1.y,p2.y,p3.y) }
}

// ── TraceLayer ────────────────────────────────────────────────────

export class TraceLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly imageSlot: ParameterSlot
  readonly maskSlot:  ParameterSlot
  readonly phaseSlot: ParameterSlot

  private readonly _numPtsSlider: SliderRegion

  private _phase:          number  = 0
  private _controlPoints:  Point[] = []
  private _lastImageId:    object | null = null
  private _lastNumPts:     number  = DEF_POINTS
  private _lastMaskActive: boolean = false
  private _forceDetect:    boolean = false
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

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
    this.imageSlot = new ParameterSlot(ValueType.Image,  this, 'image')
    this.maskSlot  = new ParameterSlot(ValueType.Mask,   this, 'mask')
    this.phaseSlot = new ParameterSlot(ValueType.Amount, this, 'phase')
    const initV = (DEF_POINTS - MIN_POINTS) / (MAX_POINTS - MIN_POINTS)
    this._numPtsSlider = new SliderRegion(this, initV)
    this.slots.push(this.imageSlot, this.maskSlot, this.phaseSlot)
    this.debugName = 'Trace'
    graph.register(this)
  }

  override autoBindRules(): ReturnType<Layer['autoBindRules']> {
    return [
      { slot: this.imageSlot, accepts: (l: Layer) => l.types.has(ValueType.Image) },
      { slot: this.maskSlot,  accepts: (l: Layer) => l.types.has(ValueType.Mask)  },
    ]
  }

  getPoint(): Point {
    return this._controlPoints.length < 2 ? { x:0,y:0 }
      : sampleSpline(this._phase, this._controlPoints)
  }

  samplePerimeter(t: number): Point {
    return this._controlPoints.length < 2 ? { x:0,y:0 }
      : sampleSpline(t, this._controlPoints)
  }

  setValue(_v: Amount): void { this.markDirty() }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  override serializeState(): Record<string, unknown> {
    return {
      phase:         this._phase,
      controlPoints: this._controlPoints,
      numPtsValue:   this._numPtsSlider.value,
    }
  }

  override deserializeState(state: Record<string, unknown>): void {
    if (typeof state.phase === 'number') this._phase = state.phase
    if (Array.isArray(state.controlPoints)) this._controlPoints = state.controlPoints as Point[]
    if (typeof state.numPtsValue === 'number') {
      this._numPtsSlider.setValue(state.numPtsValue as Amount)
      this._lastNumPts = this._numPoints()
    }
  }

  protected recompute(): void {
    if (this.phaseSlot.isActive)
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount

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

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._controlPoints.length<3) return
    ctx.save()
    ctx.strokeStyle=ACCENT; ctx.lineWidth=1.5
    ctx.beginPath()
    for (let i=0;i<=RENDER_PTS;i++) {
      const p=sampleSpline(i/RENDER_PTS,this._controlPoints)
      if (i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y)
    }
    ctx.closePath(); ctx.stroke()
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width<=0||this.bounds.height<=0) return
    this._drawPill(ctx,this.bounds)
    const cp={x:300,y:50,width:260,height:this.bounds.height}
    this._cpBounds=cp; this._drawPill(ctx,cp)
    this._drawControlHandles(ctx)
  }

  private _drawPill(ctx: Ctx2D, b: {x:number;y:number;width:number;height:number}): void {
    const {x,y,width,height}=b, midY=y+height/2, btnB=this._detectBtnBounds(b)
    const sliderW=Math.max(0,btnB.x-(x+10)-LABEL_W-8)
    this._numPtsSlider.bounds={x:x+10,y:y+6,width:sliderW,height:Math.max(0,height-12)}
    this._numPtsSlider.interactive=true; this._numPtsSlider.displayValue=this._numPtsSlider.value
    ctx.save()
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.beginPath()
    ctx.roundRect(x,y,width,height,Math.min(height/2,8)); ctx.fill()
    ctx.fillStyle=ACCENT; ctx.beginPath(); ctx.roundRect(x,y,4,height,[4,0,0,4]); ctx.fill()
    this._numPtsSlider.renderSelf(ctx)
    ctx.font='11px monospace'; ctx.textAlign='left'; ctx.textBaseline='middle'
    ctx.fillStyle=this._controlPoints.length>0?'rgba(255,255,255,0.80)':'rgba(255,255,255,0.35)'
    ctx.fillText(this._controlPoints.length>0?`${this._controlPoints.length} pts`
                 :this.imageSlot.isActive?'…':'—', x+10+sliderW+4, midY)
    ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.beginPath()
    ctx.roundRect(btnB.x,btnB.y,btnB.width,btnB.height,4); ctx.fill()
    ctx.font='bold 10px monospace'; ctx.fillStyle=ACCENT
    ctx.textAlign='center'; ctx.textBaseline='middle'
    ctx.fillText('DETECT',btnB.x+btnB.width/2,btnB.y+btnB.height/2)
    ctx.restore()
  }

  handlePointerDown(point: Point): boolean {
    // DETECT button
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._detectBtnBounds(b), point)) {
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
    this._specialDrag = null
    this._dragIndex   = -1
    this.markDirty()
  }

  protected override hitTestSelf(point: Point): this | null {
    if (this._numPtsSlider.hitTest(point)) return this
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

  private _detectBtnBounds(b: {x:number;y:number;width:number;height:number}) {
    return {x:b.x+b.width-BTN_M-BTN_W, y:b.y+(b.height-BTN_H)/2, width:BTN_W, height:BTN_H}
  }

  // ── Handle geometry ──────────────────────────────────────────────

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
      ctx.fillStyle   = lit ? ACCENT : 'rgba(207,159,126,0.30)'
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
    ctx.fillStyle   = litR ? '#ffffff' : 'rgba(207,159,126,0.85)'
    ctx.strokeStyle = 'rgba(0,0,0,0.50)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.arc(rh.x, rh.y, CP_R, 0, Math.PI*2)
    ctx.fill(); ctx.stroke()

    ctx.restore()
  }
}
