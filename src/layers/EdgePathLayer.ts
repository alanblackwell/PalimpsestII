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
import { graph }        from '../dataflow/Graph.js'
import { SliderRegion } from '../regions/SliderRegion.js'

// ------------------------------------------------------------
// EdgePathLayer — closed path traced from the boundary of a mask
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

const ACCENT      = '#cf9f7e'
const MIN_POINTS  = 4
const MAX_POINTS  = 32
const DEF_POINTS  = 10
const PROC_SIZE   = 400
const FINDER_SIZE = 128
const RENDER_PTS  = 200
const LABEL_W     = 46
const BTN_W       = 54
const BTN_H       = 22
const BTN_M       = 6
const CP_R        = 6    // control-point handle radius
const HIT_R       = 14   // pointer hit radius
const ROT_OFF     = 24   // rotate handle offset beyond max radius

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

type Px = { x: number; y: number }

// ── EdgePathLayer ────────────────────────────────────────────────

export class EdgePathLayer extends Layer implements PointSource {
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
    this.debugName = 'EdgePath'
    graph.register(this)
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

    // ── 1. Determine crop region from mask bbox ───────────────────
    let cropX = 0, cropY = 0, cropW = imageSrc.width, cropH = imageSrc.height
    if (maskSrc !== null) {
      const bb = this._maskBbox(maskSrc)
      if (bb !== null) {
        const pad = Math.max(bb.w, bb.h) * 0.05
        cropX = Math.max(0,              Math.floor(bb.x - pad))
        cropY = Math.max(0,              Math.floor(bb.y - pad))
        cropW = Math.min(imageSrc.width,  Math.ceil(bb.x + bb.w + pad)) - cropX
        cropH = Math.min(imageSrc.height, Math.ceil(bb.y + bb.h + pad)) - cropY
      }
    }

    const aspect = cropW / cropH
    const pw = aspect >= 1 ? PROC_SIZE : Math.round(PROC_SIZE * aspect)
    const ph = aspect >= 1 ? Math.round(PROC_SIZE / aspect) : PROC_SIZE

    let binary: Uint8Array

    if (maskSrc !== null) {
      // ── 2a. Mask path: downsample alpha channel → binary ──────────
      const mOsc = new OffscreenCanvas(pw, ph)
      const mCtx = mOsc.getContext('2d')!
      mCtx.drawImage(maskSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
      const mPx = mCtx.getImageData(0, 0, pw, ph).data
      binary = new Uint8Array(pw * ph)
      for (let i = 0; i < pw * ph; i++) binary[i] = mPx[i * 4 + 3] > 0 ? 1 : 0
    } else {
      // ── 2b. No-mask path: grayscale → blur → Otsu → largest blob ─
      const iOsc = new OffscreenCanvas(pw, ph)
      const iCtx = iOsc.getContext('2d')!
      iCtx.drawImage(imageSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
      const iPx = iCtx.getImageData(0, 0, pw, ph).data
      const gray = new Float32Array(pw * ph)
      for (let i = 0; i < pw * ph; i++)
        gray[i] = (0.299*iPx[i*4] + 0.587*iPx[i*4+1] + 0.114*iPx[i*4+2]) / 255
      const blurred = this._gaussBlur(gray, pw, ph)
      const thresh  = this._otsuThreshold(blurred, pw * ph)
      const raw = new Uint8Array(pw * ph)
      for (let i = 0; i < pw * ph; i++) raw[i] = blurred[i] > thresh ? 1 : 0
      binary = this._largestComponent(raw, pw, ph)
    }

    // ── 3. Moore's boundary trace → resample → canvas coords ────────
    const chain = this._traceBoundary(binary, pw, ph)
    if (chain.length < 3) { this._controlPoints = []; return }

    const resampled = this._uniformResample(chain, numPts)
    const sx = cropW / pw, sy = cropH / ph
    this._controlPoints = this._smoothPoints(
      resampled.map(p => ({ x: cropX + p.x * sx, y: cropY + p.y * sy })), 1)
  }

  // ── Mask bounding box (fast downscale scan) ──────────────────────

  private _maskBbox(mask: OffscreenCanvas): { x:number; y:number; w:number; h:number } | null {
    const F = FINDER_SIZE
    const fOsc = new OffscreenCanvas(F, F)
    const fCtx = fOsc.getContext('2d')!
    fCtx.drawImage(mask, 0, 0, F, F)
    const d = fCtx.getImageData(0, 0, F, F).data
    let x1=F, y1=F, x2=-1, y2=-1
    for (let y=0; y<F; y++) for (let x=0; x<F; x++)
      if (d[(y*F+x)*4+3] > 10) {
        if (x<x1)x1=x; if (y<y1)y1=y; if (x>x2)x2=x; if (y>y2)y2=y
      }
    if (x2 < x1) return null
    return {
      x: Math.floor(x1/F * mask.width),  y: Math.floor(y1/F * mask.height),
      w: Math.ceil((x2-x1+1)/F * mask.width), h: Math.ceil((y2-y1+1)/F * mask.height),
    }
  }

  // ── Moore's boundary tracing ────────────────────────────────────
  // Traces the exterior perimeter of the foreground region in
  // `binary` (1=foreground, 0=background) in clockwise order,
  // returning an ordered chain of boundary pixel coordinates.

  private _traceBoundary(binary: Uint8Array, W: number, H: number): Px[] {
    // Find topmost, leftmost foreground pixel (guaranteed boundary).
    let sx = -1, sy = -1
    outer: for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (binary[y * W + x]) { sx = x; sy = y; break outer }
      }
    }
    if (sx < 0) return []

    // 8-connected clockwise direction table (E, SE, S, SW, W, NW, N, NE).
    const DX = [ 1,  1,  0, -1, -1, -1,  0,  1]
    const DY = [ 0,  1,  1,  1,  0, -1, -1, -1]

    const path: Px[] = []
    let bx = sx, by = sy
    // Entry backtrack direction: W (4), because s is the leftmost pixel
    // in its row so the pixel to the left is background (or out of bounds).
    let iterDir = 4

    const maxIter = W * H * 2
    for (let iter = 0; iter < maxIter; iter++) {
      path.push({ x: bx, y: by })

      let foundDir = -1, lastBgDir = iterDir
      for (let k = 0; k < 8; k++) {
        const d = (iterDir + k) % 8
        const nx = bx + DX[d], ny = by + DY[d]
        const fg = nx >= 0 && ny >= 0 && nx < W && ny < H && binary[ny * W + nx] !== 0
        if (fg) { foundDir = d; break }
        lastBgDir = d
      }

      if (foundDir < 0) break // isolated pixel

      const nx = bx + DX[foundDir], ny = by + DY[foundDir]
      if (nx === sx && ny === sy && path.length > 1) break // closed loop

      // New entry direction for the next pixel.
      // lastBgDir is always one clockwise step before foundDir, so
      // (DX[lastBgDir]-DX[foundDir], DY[lastBgDir]-DY[foundDir]) is
      // always a valid 8-direction.
      const ex = DX[lastBgDir] - DX[foundDir]
      const ey = DY[lastBgDir] - DY[foundDir]
      let newDir = 0
      for (let i = 0; i < 8; i++) {
        if (DX[i] === ex && DY[i] === ey) { newDir = i; break }
      }

      bx = nx; by = ny; iterDir = newDir
    }

    return path
  }

  // ── Otsu threshold (returns value in [0,1]) ───────────────────────

  private _otsuThreshold(gray: Float32Array, N: number): number {
    const hist = new Float32Array(256)
    for (let i = 0; i < N; i++) hist[Math.min(255, gray[i] * 255 | 0)]++
    let sumAll = 0
    for (let i = 0; i < 256; i++) sumAll += i * hist[i]
    let sumB = 0, wB = 0, maxVar = 0, thresh = 128
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue
      const wF = N - wB; if (wF === 0) break
      sumB += t * hist[t]
      const mB = sumB / wB, mF = (sumAll - sumB) / wF
      const v = wB * wF * (mB - mF) * (mB - mF)
      if (v > maxVar) { maxVar = v; thresh = t }
    }
    return thresh / 255
  }

  // ── Largest 4-connected foreground component ─────────────────────

  private _largestComponent(binary: Uint8Array, W: number, H: number): Uint8Array {
    const N = W * H
    const label = new Int32Array(N)
    let nextLabel = 1, bestLabel = 0, bestSize = 0
    const sizes: number[] = [0]
    for (let i = 0; i < N; i++) {
      if (!binary[i] || label[i]) continue
      const lbl = nextLabel++; sizes.push(0)
      const q = [i]; label[i] = lbl; let qi = 0
      while (qi < q.length) {
        const idx = q[qi++]; sizes[lbl]++
        const x = idx % W, y = (idx / W) | 0
        for (const n of [y > 0 ? idx-W : -1, y < H-1 ? idx+W : -1,
                          x > 0 ? idx-1 : -1, x < W-1 ? idx+1 : -1]) {
          if (n >= 0 && binary[n] && !label[n]) { label[n] = lbl; q.push(n) }
        }
      }
      if ((sizes[lbl] ?? 0) > bestSize) { bestSize = sizes[lbl] ?? 0; bestLabel = lbl }
    }
    const out = new Uint8Array(N)
    if (bestLabel > 0) for (let i = 0; i < N; i++) out[i] = label[i] === bestLabel ? 1 : 0
    return out
  }

  // ── Gaussian blur (5-tap separable) ─────────────────────────────

  private _gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
    const k=[0.0545,0.2442,0.4026,0.2442,0.0545]
    const tmp=new Float32Array(W*H), out=new Float32Array(W*H)
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=src[y*W+Math.max(0,Math.min(W-1,x+d))]*k[d+2]; tmp[y*W+x]=s }
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=tmp[Math.max(0,Math.min(H-1,y+d))*W+x]*k[d+2]; out[y*W+x]=s }
    return out
  }

  // ── Uniform arc-length resampler ────────────────────────────────

  private _uniformResample(pts: Px[], n: number): Px[] {
    if (pts.length<2) return pts.length===0?[]:Array(n).fill(pts[0])
    const len=[0]
    for (let i=1;i<pts.length;i++) {
      const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y
      len.push(len[i-1]+Math.sqrt(dx*dx+dy*dy))
    }
    const total=len[len.length-1]; if (total===0) return pts.slice(0,n)
    const out: Px[]=[]
    let j=0
    for (let i=0;i<n;i++) {
      const tgt=(i/n)*total
      while (j<len.length-2&&len[j+1]<tgt) j++
      const sp=len[j+1]-len[j], t=sp>0?(tgt-len[j])/sp:0
      out.push({x:pts[j].x+t*(pts[j+1].x-pts[j].x),y:pts[j].y+t*(pts[j+1].y-pts[j].y)})
    }
    return out
  }

  private _smoothPoints(pts: Point[], passes: number): Point[] {
    let cur=pts.slice()
    for (let p=0;p<passes;p++) {
      const n=cur.length, next: Point[]=[]
      for (let i=0;i<n;i++) {
        const a=cur[(i-1+n)%n],b=cur[i],c=cur[(i+1)%n]
        next.push({x:(a.x+2*b.x+c.x)/4,y:(a.y+2*b.y+c.y)/4})
      }
      cur=next
    }
    return cur
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
