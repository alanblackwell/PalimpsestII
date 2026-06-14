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
// EdgePathLayer — closed path derived from image edges via
// Canny detection + Live Wire (Intelligent Scissors / Dijkstra)
// ------------------------------------------------------------
//
// Three-phase pipeline:
//
//   Phase 1 — Seed placement
//
//     WITHOUT mask: scale image to PROC_SIZE, cast N rays from the
//     centre outward, stop each ray at the first NMS-thinned edge
//     above the adaptive threshold.
//
//     WITH mask: find the mask bounding box (fast FINDER_SIZE scan),
//     crop both image and mask to that region + 5 % padding, then
//     scale to PROC_SIZE.  Seeds are placed by walking outward from
//     the mask centroid along N rays and recording the last masked
//     pixel on each ray (= the mask perimeter).
//
//   Phase 2 — Canny edge detection
//     greyscale → Gaussian blur → Sobel (magnitude + direction) →
//     non-maximum suppression (thin edges to 1-pixel-wide curves) →
//     hysteresis thresholding (two-level: keep strong edges and any
//     weak edges connected to them; suppress the rest).
//
//     A binary cost map is built from the Canny result:
//       edge pixel   → cost 0.01   (strongly preferred)
//       non-edge     → cost 1.0    (heavily penalised)
//     The 100× ratio makes the path snap to edges and follow them
//     rather than cutting through gradient blur.
//
//   Phase 2 — Live Wire (Dijkstra)
//     8-connected shortest path through the cost map between each
//     consecutive seed pair.  The mask is NOT used as a graph
//     constraint here — it applies only to seed placement.  This
//     allows the path to reach edge pixels that sit exactly on or
//     just outside the painted mask boundary.
//
//   Phase 3 — Arc-length resample + Catmull-Rom
//     Dense pixel chain → N uniformly-spaced points → 1-pass
//     binomial smooth → closed Catmull-Rom spline in canvas coords.
//
// Inputs:
//   imageSlot (Image)  — source bitmap
//   maskSlot  (Mask)   — optional; crops the working region and
//                        seeds rays from the mask perimeter
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

// Edge / non-edge costs for the Live Wire cost map.
const EDGE_COST     = 0.01
const NON_EDGE_COST = 1.0

// ── Binary min-heap ──────────────────────────────────────────────

class MinHeap {
  private _c: Float32Array
  private _i: Int32Array
  private _n = 0

  constructor(cap = 8192) {
    this._c = new Float32Array(cap)
    this._i = new Int32Array(cap)
  }

  get size(): number { return this._n }

  push(cost: number, id: number): void {
    if (this._n >= this._c.length) {
      const nc = new Float32Array(this._c.length * 2); nc.set(this._c); this._c = nc
      const ni = new Int32Array(this._i.length * 2);   ni.set(this._i); this._i = ni
    }
    let k = this._n++
    this._c[k] = cost; this._i[k] = id
    while (k > 0) {
      const p = (k - 1) >> 1
      if (this._c[p] <= this._c[k]) break
      this._sw(p, k); k = p
    }
  }

  pop(): { cost: number; id: number } | null {
    if (this._n === 0) return null
    const rc = this._c[0], ri = this._i[0]
    if (--this._n > 0) {
      this._c[0] = this._c[this._n]; this._i[0] = this._i[this._n]
      let k = 0
      for (;;) {
        let m = k, l = 2*k+1, r = l+1
        if (l < this._n && this._c[l] < this._c[m]) m = l
        if (r < this._n && this._c[r] < this._c[m]) m = r
        if (m === k) break
        this._sw(m, k); k = m
      }
    }
    return { cost: rc, id: ri }
  }

  private _sw(a: number, b: number): void {
    const tc = this._c[a], ti = this._i[a]
    this._c[a] = this._c[b]; this._i[a] = this._i[b]
    this._c[b] = tc; this._i[b] = ti
  }
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

    // ── 1. Determine crop region ───────────────────────────────────
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

    // ── 2. Extract cropped image → greyscale ───────────────────────
    const iOsc = new OffscreenCanvas(pw, ph)
    const iCtx = iOsc.getContext('2d')!
    iCtx.drawImage(imageSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
    const iPx = iCtx.getImageData(0, 0, pw, ph).data

    const gray = new Float32Array(pw * ph)
    for (let i = 0; i < pw * ph; i++)
      gray[i] = (0.299*iPx[i*4] + 0.587*iPx[i*4+1] + 0.114*iPx[i*4+2]) / 255

    // ── 3. Canny edge detection ────────────────────────────────────
    const blurred        = this._gaussBlur(gray, pw, ph)
    const { mag, gx, gy} = this._sobelGrad(blurred, pw, ph)
    const nms            = this._nonMaxSuppress(mag, gx, gy, pw, ph)

    // Adaptive thresholds from NMS magnitude distribution.
    const nzMag: number[] = []
    for (const v of nms) if (v > 0) nzMag.push(v)
    nzMag.sort((a, b) => a - b)
    const highT = nzMag.length > 0 ? nzMag[Math.floor(nzMag.length * 0.75)] : 0.1
    const lowT  = highT * 0.30

    const cannyEdges = this._hysteresis(nms, pw, ph, highT, lowT)

    // ── 4. Build Live Wire cost map ────────────────────────────────
    // Canny edge pixels are almost free to traverse; everything else
    // is heavily penalised.  The 100× ratio snaps the path onto edges.
    const cost = new Float32Array(pw * ph)
    for (let i = 0; i < cost.length; i++)
      cost[i] = cannyEdges[i] ? EDGE_COST : NON_EDGE_COST

    // ── 5. Mask pixels (for seed placement only) ───────────────────
    let maskPx: Uint8ClampedArray | null = null
    if (maskSrc !== null) {
      const mOsc = new OffscreenCanvas(pw, ph)
      const mCtx = mOsc.getContext('2d')!
      mCtx.drawImage(maskSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
      maskPx = mCtx.getImageData(0, 0, pw, ph).data
    }

    // ── 6. Phase 1: seeds ──────────────────────────────────────────
    const seeds = maskPx !== null
      ? this._seedsFromMask(maskPx, pw, ph, numPts)
      : this._seedsFromEdges(nms, pw, ph, highT, numPts)

    // ── 7. Phase 2: Live Wire (mask NOT used as graph constraint) ──
    const chain: Px[] = []
    for (let i = 0; i < numPts; i++) {
      const seg = this._liveWire(cost, pw, ph, seeds[i], seeds[(i+1) % numPts])
      for (let j = 0; j < seg.length - 1; j++) chain.push(seg[j])
    }

    // ── 8. Phase 3: resample → canvas coords ──────────────────────
    const resampled = this._uniformResample(chain, numPts)
    const sx = cropW / pw, sy = cropH / ph
    this._controlPoints = this._smoothPoints(
      resampled.map(p => ({ x: cropX + p.x * sx, y: cropY + p.y * sy })), 1)
  }

  // ── Mask bounding box ────────────────────────────────────────────

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

  // ── Phase 1a: seeds from mask perimeter ─────────────────────────
  // Walk outward from the mask centroid; the seed on each ray is the
  // last masked pixel before the ray exits the mask.

  private _seedsFromMask(maskPx: Uint8ClampedArray, W: number, H: number, n: number): Px[] {
    let sx=0, sy=0, cnt=0
    for (let y=0; y<H; y++) for (let x=0; x<W; x++)
      if (maskPx[(y*W+x)*4+3] > 0) { sx+=x; sy+=y; cnt++ }
    const cx = cnt>0 ? sx/cnt : W/2, cy = cnt>0 ? sy/cnt : H/2
    const maxR = Math.sqrt(W*W + H*H)

    return Array.from({ length: n }, (_, i) => {
      const angle = (i/n)*Math.PI*2 - Math.PI/2
      const dx=Math.cos(angle), dy=Math.sin(angle)
      let last: Px | null = null
      for (let r=0; r<maxR; r+=0.5) {
        const px=cx+dx*r, py=cy+dy*r
        const ix=Math.round(px), iy=Math.round(py)
        if (ix<0||iy<0||ix>=W||iy>=H) break
        if (maskPx[(iy*W+ix)*4+3] > 0) last={x:px,y:py}
      }
      return last ?? { x:cx+dx*Math.min(W,H)*0.4, y:cy+dy*Math.min(W,H)*0.4 }
    })
  }

  // ── Phase 1b: seeds from NMS edge map (no mask) ──────────────────
  // Walk from outer margin inward; stop at first NMS peak above threshold.

  private _seedsFromEdges(
    nms: Float32Array, W: number, H: number, threshold: number, n: number,
  ): Px[] {
    const cx=W/2, cy=H/2, maxR=Math.min(W,H)*0.47, minR=maxR*0.08
    return Array.from({ length: n }, (_, i) => {
      const angle = (i/n)*Math.PI*2 - Math.PI/2
      const dx=Math.cos(angle), dy=Math.sin(angle)
      let hit: Px|null=null, peakV=0, peakP: Px|null=null
      for (let r=maxR; r>=minR; r-=0.5) {
        const px=cx+dx*r, py=cy+dy*r
        const ix=Math.round(px), iy=Math.round(py)
        if (ix<1||iy<1||ix>=W-1||iy>=H-1) continue
        const e=nms[iy*W+ix]
        if (e>peakV) { peakV=e; peakP={x:px,y:py} }
        if (hit===null && e>=threshold) hit={x:px,y:py}
      }
      return hit ?? peakP ?? { x:cx+dx*maxR*0.65, y:cy+dy*maxR*0.65 }
    })
  }

  // ── Phase 2: Dijkstra ────────────────────────────────────────────

  private _liveWire(cost: Float32Array, W: number, H: number, src: Px, dst: Px): Px[] {
    const N=W*H
    const si=Math.max(0,Math.min(W-1,Math.round(src.x)))
    const sj=Math.max(0,Math.min(H-1,Math.round(src.y)))
    const di=Math.max(0,Math.min(W-1,Math.round(dst.x)))
    const dj=Math.max(0,Math.min(H-1,Math.round(dst.y)))
    const sid=sj*W+si, did=dj*W+di
    if (sid===did) return [{x:si,y:sj}]

    const dist=new Float32Array(N).fill(Infinity)
    const prev=new Int32Array(N).fill(-1)
    const vis =new Uint8Array(N)
    dist[sid]=0
    const heap=new MinHeap(Math.min(N,16384))
    heap.push(0,sid)

    const DIRS: [number,number,number][] = [
      [-1,0,1],[1,0,1],[0,-1,1],[0,1,1],
      [-1,-1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[1,1,Math.SQRT2],
    ]

    while (heap.size > 0) {
      const top=heap.pop()!
      if (top.cost>dist[top.id]||vis[top.id]) continue
      vis[top.id]=1
      if (top.id===did) break
      const x=top.id%W, y=(top.id/W)|0
      for (const [dx,dy,md] of DIRS) {
        const nx=x+dx, ny=y+dy
        if (nx<0||ny<0||nx>=W||ny>=H) continue
        const nid=ny*W+nx; if (vis[nid]) continue
        const nd=dist[top.id]+(cost[top.id]+cost[nid])*0.5*md
        if (nd<dist[nid]) { dist[nid]=nd; prev[nid]=top.id; heap.push(nd,nid) }
      }
    }

    const path: Px[]=[]
    for (let cur=did; cur!==-1&&path.length<=N; cur=prev[cur]) {
      path.push({x:cur%W,y:(cur/W)|0}); if (cur===sid) break
    }
    if (path.length===0||path[path.length-1].x!==si||path[path.length-1].y!==sj)
      return [{x:si,y:sj},{x:di,y:dj}]
    path.reverse(); return path
  }

  // ── Phase 3: uniform arc-length resampler ────────────────────────

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

  // ── Canny edge detection ─────────────────────────────────────────

  private _gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
    const k=[0.0545,0.2442,0.4026,0.2442,0.0545]
    const tmp=new Float32Array(W*H), out=new Float32Array(W*H)
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=src[y*W+Math.max(0,Math.min(W-1,x+d))]*k[d+2]; tmp[y*W+x]=s }
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=tmp[Math.max(0,Math.min(H-1,y+d))*W+x]*k[d+2]; out[y*W+x]=s }
    return out
  }

  // Sobel returning magnitude and both gradient components.
  private _sobelGrad(
    src: Float32Array, W: number, H: number,
  ): { mag: Float32Array; gx: Float32Array; gy: Float32Array } {
    const mag=new Float32Array(W*H), gx=new Float32Array(W*H), gy=new Float32Array(W*H)
    for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
      const a=src[(y-1)*W+(x-1)],b=src[(y-1)*W+x],c=src[(y-1)*W+(x+1)]
      const d=src[y*W+(x-1)],f=src[y*W+(x+1)]
      const g=src[(y+1)*W+(x-1)],h=src[(y+1)*W+x],j=src[(y+1)*W+(x+1)]
      const gxi=-a-2*d-g+c+2*f+j, gyi=-a-2*b-c+g+2*h+j
      gx[y*W+x]=gxi; gy[y*W+x]=gyi; mag[y*W+x]=Math.sqrt(gxi*gxi+gyi*gyi)
    }
    return {mag,gx,gy}
  }

  // Non-maximum suppression: keep only local maxima along the gradient
  // direction, thinning edges to 1-pixel-wide curves.
  private _nonMaxSuppress(
    mag: Float32Array, gx: Float32Array, gy: Float32Array, W: number, H: number,
  ): Float32Array {
    const out=new Float32Array(W*H)
    for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
      const i=y*W+x, m=mag[i]; if (m===0) continue
      // Map gradient angle to one of four quantised directions.
      const theta=(((Math.atan2(gy[i],gx[i])*4/Math.PI)%4)+4)%4
      let m1: number, m2: number
      if      (theta<0.5||theta>=3.5) { m1=mag[i-1];   m2=mag[i+1]   }  // 0°  H
      else if (theta<1.5)             { m1=mag[i-W+1];  m2=mag[i+W-1] }  // 45° /
      else if (theta<2.5)             { m1=mag[i-W];    m2=mag[i+W]   }  // 90° V
      else                            { m1=mag[i-W-1];  m2=mag[i+W+1] }  // 135°\
      if (m>=m1&&m>=m2) out[i]=m
    }
    return out
  }

  // Hysteresis thresholding: seed with strong edges, grow to connected
  // weak edges using BFS.
  private _hysteresis(
    nms: Float32Array, W: number, H: number, highT: number, lowT: number,
  ): Uint8Array {
    const N=W*H, out=new Uint8Array(N), queue: number[]=[]
    for (let i=0;i<N;i++) if (nms[i]>=highT) { out[i]=1; queue.push(i) }
    const DIRS=[-W-1,-W,-W+1,-1,1,W-1,W,W+1]
    let qi=0
    while (qi<queue.length) {
      const id=queue[qi++], x=id%W, y=(id/W)|0
      for (const d of DIRS) {
        const nid=id+d
        if (nid<0||nid>=N) continue
        const nx=nid%W
        // Skip if we wrapped across the image boundary horizontally.
        if (Math.abs(nx-x)>1) continue
        if (!out[nid]&&nms[nid]>=lowT) { out[nid]=1; queue.push(nid) }
      }
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
    ctx.fillStyle=ACCENT
    for (const cp of this._controlPoints) {
      ctx.beginPath(); ctx.arc(cp.x,cp.y,2.5,0,Math.PI*2); ctx.fill()
    }
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width<=0||this.bounds.height<=0) return
    this._drawPill(ctx,this.bounds)
    const cp={x:300,y:50,width:260,height:this.bounds.height}
    this._cpBounds=cp; this._drawPill(ctx,cp)
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
    ctx.fillText(this._controlPoints.length>0?`${this._numPoints()} pts`
                 :this.imageSlot.isActive?'…':'—', x+10+sliderW+4, midY)
    ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.beginPath()
    ctx.roundRect(btnB.x,btnB.y,btnB.width,btnB.height,4); ctx.fill()
    ctx.font='bold 10px monospace'; ctx.fillStyle=ACCENT
    ctx.textAlign='center'; ctx.textBaseline='middle'
    ctx.fillText('DETECT',btnB.x+btnB.width/2,btnB.y+btnB.height/2)
    ctx.restore()
  }

  handlePointerDown(point: Point): boolean {
    const b=this._cpBounds??this.bounds
    if (boundingBoxContains(this._detectBtnBounds(b),point)) {
      this._forceDetect=true; this.markDirty(); return true
    }
    return false
  }

  protected override hitTestSelf(point: Point) { return this._numPtsSlider.hitTest(point) }

  private _detectBtnBounds(b: {x:number;y:number;width:number;height:number}) {
    return {x:b.x+b.width-BTN_M-BTN_W, y:b.y+(b.height-BTN_H)/2, width:BTN_W, height:BTN_H}
  }
}
