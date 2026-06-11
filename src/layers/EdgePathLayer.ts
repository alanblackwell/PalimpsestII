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
// EdgePathLayer — derives a closed path from an image using
// Intelligent Scissors (Live Wire) guided by a Sobel edge map
// ------------------------------------------------------------
//
// Three-phase pipeline:
//
//   Phase 1 — Seed placement
//
//     WITHOUT mask: image is scaled to PROC_SIZE, N rays are cast from
//     the image centre outward, each stopping at the outermost Sobel
//     edge above an adaptive threshold (65th percentile of non-zero
//     values).
//
//     WITH mask: the mask's tight bounding box (found via a fast
//     FINDER_SIZE scan) is used to crop both the image and the mask to
//     the region of interest, which is then scaled to PROC_SIZE.  This
//     focuses the available resolution on the relevant area.  Seeds are
//     placed by walking outward from the mask centroid along N equally-
//     spaced rays and recording the last masked pixel on each ray — i.e.
//     the point where the ray exits the mask.  Seeds therefore lie
//     exactly on the mask perimeter rather than anywhere in the image.
//
//   Phase 2 — Live Wire (Dijkstra)
//     cost = 1 − normalised_edge_magnitude.  Strong Sobel edges cost ≈ 0;
//     flat regions cost ≈ 1.  Dijkstra finds the cheapest 8-connected
//     path between each consecutive seed pair.  With a mask, nodes outside
//     the mask are excluded from the graph, further confining the search.
//     All N segments are concatenated into a dense pixel chain.
//
//   Phase 3 — Arc-length resample
//     The dense chain is resampled at N uniformly-spaced arc-length
//     positions → N Catmull-Rom control points, one light smoothing pass.
//
// Coordinate system:
//   ImageLayer.getImage() and MaskLayer.getMask() return full-canvas
//   OffscreenCanvases already in canvas space.  When a mask crop is
//   applied, results are transformed back to canvas coordinates before
//   storage.  samplePerimeter() always returns canvas coordinates.
//
// Inputs:
//   imageSlot (Image)  — source bitmap
//   maskSlot  (Mask)   — optional; guides Phase 1 seeds and constrains
//                        Phase 2 to the masked region
//   phaseSlot (Amount) — position along perimeter [0, 1]
//
// Panel: numPoints slider (4 – 32, default 10) + [DETECT] button.

const ACCENT      = '#cf9f7e'
const MIN_POINTS  = 4
const MAX_POINTS  = 32
const DEF_POINTS  = 10
const PROC_SIZE   = 400   // working-copy max dimension
const FINDER_SIZE = 128   // resolution for fast bounding-box scan
const RENDER_PTS  = 200
const LABEL_W     = 46
const BTN_W       = 54
const BTN_H       = 22
const BTN_M       = 6

// ── Binary min-heap ──────────────────────────────────────────────

class MinHeap {
  private _c: Float32Array
  private _i: Int32Array
  private _n = 0

  constructor(cap = 8192) { this._c = new Float32Array(cap); this._i = new Int32Array(cap) }

  get size(): number { return this._n }

  push(cost: number, id: number): void {
    if (this._n >= this._c.length) {
      const nc = new Float32Array(this._c.length * 2); nc.set(this._c); this._c = nc
      const ni = new Int32Array(this._i.length * 2);   ni.set(this._i); this._i = ni
    }
    let k = this._n++; this._c[k] = cost; this._i[k] = id
    while (k > 0) { const p = (k-1)>>1; if (this._c[p] <= this._c[k]) break; this._sw(p,k); k=p }
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
        if (m === k) break; this._sw(m,k); k=m
      }
    }
    return { cost: rc, id: ri }
  }

  private _sw(a: number, b: number): void {
    const tc=this._c[a], ti=this._i[a]
    this._c[a]=this._c[b]; this._i[a]=this._i[b]; this._c[b]=tc; this._i[b]=ti
  }
}

// ── Catmull-Rom ──────────────────────────────────────────────────

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5*( 2*p1 + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t*t + (-p0+3*p1-3*p2+p3)*t*t*t )
}

function sampleSpline(t: number, pts: Point[]): Point {
  const n=pts.length, s=(((t%1)+1)%1)*n, i=Math.floor(s), u=s-i
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
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(this._phase, this._controlPoints)
  }

  samplePerimeter(t: number): Point {
    return this._controlPoints.length < 2 ? { x: 0, y: 0 }
      : sampleSpline(t, this._controlPoints)
  }

  setValue(_v: Amount): void { this.markDirty() }

  protected recompute(): void {
    if (this.phaseSlot.isActive)
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount

    const numPts     = this._numPoints()
    const maskActive = this.maskSlot.isActive
    const imageVal   = this.imageSlot.isActive
      ? (this.imageSlot.source as ImageSource).getImage() : null
    const maskVal    = maskActive
      ? (this.maskSlot.source as MaskSource).getMask() : null

    const imageId = imageVal as object | null
    const needsDetect =
      this._forceDetect || imageId !== this._lastImageId ||
      numPts !== this._lastNumPts || maskActive !== this._lastMaskActive

    if (needsDetect && imageVal !== null) {
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
    // ── Determine crop region (canvas-pixel coords) ────────────────
    // With a mask: crop to the mask's bounding box + 5 % padding.
    // This focuses PROC_SIZE pixels on the region of interest.
    let cropX = 0, cropY = 0, cropW = imageSrc.width, cropH = imageSrc.height

    if (maskSrc !== null) {
      const bb = this._maskBbox(maskSrc)
      if (bb !== null) {
        const pad = Math.max(bb.w, bb.h) * 0.05
        cropX = Math.max(0,              Math.floor(bb.x - pad))
        cropY = Math.max(0,              Math.floor(bb.y - pad))
        const x2 = Math.min(imageSrc.width,  Math.ceil(bb.x + bb.w + pad))
        const y2 = Math.min(imageSrc.height, Math.ceil(bb.y + bb.h + pad))
        cropW = x2 - cropX; cropH = y2 - cropY
      }
    }

    // ── Scale cropped region to PROC_SIZE ──────────────────────────
    const aspect = cropW / cropH
    const pw = aspect >= 1 ? PROC_SIZE : Math.round(PROC_SIZE * aspect)
    const ph = aspect >= 1 ? Math.round(PROC_SIZE / aspect) : PROC_SIZE

    // Image → greyscale → blur → Sobel → cost
    const imgOsc = new OffscreenCanvas(pw, ph)
    const imgCtx = imgOsc.getContext('2d')!
    imgCtx.drawImage(imageSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
    const imgPx = imgCtx.getImageData(0, 0, pw, ph).data

    const gray = new Float32Array(pw * ph)
    for (let i = 0; i < pw * ph; i++)
      gray[i] = (0.299*imgPx[i*4] + 0.587*imgPx[i*4+1] + 0.114*imgPx[i*4+2]) / 255

    const edges = this._sobel(this._gaussBlur(gray, pw, ph), pw, ph)

    let maxEdge = 0
    for (const v of edges) if (v > maxEdge) maxEdge = v
    const cost = new Float32Array(pw * ph)
    if (maxEdge > 0) for (let i = 0; i < cost.length; i++) cost[i] = 1 - edges[i]/maxEdge
    else             cost.fill(1)

    // Adaptive threshold for unmasked seed placement.
    const nz: number[] = []
    for (const v of edges) if (v > 0) nz.push(v)
    nz.sort((a, b) => a - b)
    const threshold = nz.length > 0 ? nz[Math.floor(nz.length * 0.65)] : 0

    // ── Mask pixel data (cropped + scaled) ─────────────────────────
    let maskPx: Uint8ClampedArray | null = null
    if (maskSrc !== null) {
      const mOsc = new OffscreenCanvas(pw, ph)
      const mCtx = mOsc.getContext('2d')!
      mCtx.drawImage(maskSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
      maskPx = mCtx.getImageData(0, 0, pw, ph).data
    }

    // ── Phase 1: seeds ─────────────────────────────────────────────
    const seeds = maskPx !== null
      ? this._seedsFromMask(maskPx, pw, ph, numPts)
      : this._seedsFromEdges(edges, pw, ph, threshold, numPts)

    // ── Phase 2: Live Wire ─────────────────────────────────────────
    const chain: Px[] = []
    for (let i = 0; i < numPts; i++) {
      const seg = this._liveWire(cost, maskPx, pw, ph, seeds[i], seeds[(i+1) % numPts])
      for (let j = 0; j < seg.length - 1; j++) chain.push(seg[j])
    }

    // ── Phase 3: resample → control points (canvas coords) ─────────
    const resampled = this._uniformResample(chain, numPts)
    const sx = cropW / pw, sy = cropH / ph
    this._controlPoints = this._smoothPoints(
      resampled.map(p => ({ x: cropX + p.x * sx, y: cropY + p.y * sy })), 1)
  }

  // ── Mask bounding box (canvas-pixel coords) ──────────────────────
  // Scans the mask at FINDER_SIZE to quickly locate non-zero pixels.

  private _maskBbox(mask: OffscreenCanvas): { x: number; y: number; w: number; h: number } | null {
    const F = FINDER_SIZE
    const fOsc = new OffscreenCanvas(F, F)
    const fCtx = fOsc.getContext('2d')!
    fCtx.drawImage(mask, 0, 0, F, F)
    const d = fCtx.getImageData(0, 0, F, F).data
    let x1 = F, y1 = F, x2 = -1, y2 = -1
    for (let y = 0; y < F; y++)
      for (let x = 0; x < F; x++)
        if (d[(y*F+x)*4+3] > 10) {
          if (x < x1) x1 = x; if (y < y1) y1 = y
          if (x > x2) x2 = x; if (y > y2) y2 = y
        }
    if (x2 < x1) return null
    const mW = mask.width, mH = mask.height
    return {
      x: Math.floor(x1 / F * mW),
      y: Math.floor(y1 / F * mH),
      w: Math.ceil((x2 - x1 + 1) / F * mW),
      h: Math.ceil((y2 - y1 + 1) / F * mH),
    }
  }

  // ── Phase 1a: seeds from mask boundary ───────────────────────────
  // Compute the mask centroid, then cast N rays outward from it.
  // The seed on each ray is the last masked pixel before the ray exits
  // the mask — i.e. a point on the mask perimeter.

  private _seedsFromMask(maskPx: Uint8ClampedArray, W: number, H: number, n: number): Px[] {
    // Centroid of masked pixels.
    let sx = 0, sy = 0, count = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (maskPx[(y*W+x)*4+3] > 0) { sx += x; sy += y; count++ }

    const cx = count > 0 ? sx / count : W / 2
    const cy = count > 0 ? sy / count : H / 2
    // Walk far enough to reach any corner of the image.
    const maxR = Math.sqrt(W*W + H*H)

    const seeds: Px[] = []
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2
      const dx = Math.cos(angle), dy = Math.sin(angle)

      let lastMasked: Px | null = null
      for (let r = 0; r < maxR; r += 0.5) {
        const px = cx + dx*r, py = cy + dy*r
        const ix = Math.round(px), iy = Math.round(py)
        if (ix < 0 || iy < 0 || ix >= W || iy >= H) break
        if (maskPx[(iy*W+ix)*4+3] > 0) lastMasked = { x: px, y: py }
      }
      // Fallback if ray never enters the mask (centroid outside mask).
      seeds.push(lastMasked ?? { x: cx + dx * Math.min(W,H) * 0.4,
                                  y: cy + dy * Math.min(W,H) * 0.4 })
    }
    return seeds
  }

  // ── Phase 1b: seeds from edge map (no mask) ──────────────────────
  // Walk from outer margin inward; stop at the first Sobel edge above
  // the adaptive threshold.

  private _seedsFromEdges(
    edges: Float32Array, W: number, H: number, threshold: number, n: number,
  ): Px[] {
    const cx = W/2, cy = H/2
    const maxR = Math.min(W,H) * 0.47, minR = maxR * 0.08
    const seeds: Px[] = []

    for (let i = 0; i < n; i++) {
      const angle = (i/n) * Math.PI*2 - Math.PI/2
      const dx = Math.cos(angle), dy = Math.sin(angle)
      let hit: Px | null = null, peakVal = 0, peakPt: Px | null = null

      for (let r = maxR; r >= minR; r -= 0.5) {
        const px = cx+dx*r, py = cy+dy*r
        const ix = Math.round(px), iy = Math.round(py)
        if (ix<1||iy<1||ix>=W-1||iy>=H-1) continue
        const e = edges[iy*W+ix]
        if (e > peakVal) { peakVal = e; peakPt = {x:px,y:py} }
        if (hit === null && e >= threshold) hit = {x:px,y:py}
      }
      seeds.push(hit ?? peakPt ?? { x: cx+dx*maxR*0.65, y: cy+dy*maxR*0.65 })
    }
    return seeds
  }

  // ── Phase 2: Dijkstra (Live Wire) ───────────────────────────────

  private _liveWire(
    cost: Float32Array, mask: Uint8ClampedArray | null,
    W: number, H: number, src: Px, dst: Px,
  ): Px[] {
    const N = W*H
    const si = Math.max(0,Math.min(W-1,Math.round(src.x)))
    const sj = Math.max(0,Math.min(H-1,Math.round(src.y)))
    const di = Math.max(0,Math.min(W-1,Math.round(dst.x)))
    const dj = Math.max(0,Math.min(H-1,Math.round(dst.y)))
    const sid = sj*W+si, did = dj*W+di
    if (sid === did) return [{ x: si, y: sj }]

    const dist = new Float32Array(N).fill(Infinity)
    const prev = new Int32Array(N).fill(-1)
    const vis  = new Uint8Array(N)
    dist[sid] = 0
    const heap = new MinHeap(Math.min(N, 16384))
    heap.push(0, sid)

    const DIRS: [number,number,number][] = [
      [-1,0,1],[1,0,1],[0,-1,1],[0,1,1],
      [-1,-1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[1,1,Math.SQRT2],
    ]

    while (heap.size > 0) {
      const top = heap.pop()!
      if (top.cost > dist[top.id] || vis[top.id]) continue
      vis[top.id] = 1
      if (top.id === did) break
      const x = top.id % W, y = (top.id/W)|0
      for (const [dx,dy,md] of DIRS) {
        const nx=x+dx, ny=y+dy
        if (nx<0||ny<0||nx>=W||ny>=H) continue
        const nid=ny*W+nx
        if (vis[nid]) continue
        if (mask !== null && mask[nid*4+3] < 10) continue
        const nd = dist[top.id] + (cost[top.id]+cost[nid])*0.5*md
        if (nd < dist[nid]) { dist[nid]=nd; prev[nid]=top.id; heap.push(nd,nid) }
      }
    }

    // Backtrack dst → src.
    const path: Px[] = []
    for (let cur=did; cur!==-1 && path.length<=N; cur=prev[cur]) {
      path.push({ x: cur%W, y: (cur/W)|0 })
      if (cur===sid) break
    }
    if (path.length===0 || path[path.length-1].x!==si || path[path.length-1].y!==sj)
      return [{ x:si, y:sj }, { x:di, y:dj }]
    path.reverse()
    return path
  }

  // ── Phase 3: uniform arc-length resampler ────────────────────────

  private _uniformResample(pts: Px[], n: number): Px[] {
    if (pts.length < 2) return pts.length===0 ? [] : Array(n).fill(pts[0])
    const len = [0]
    for (let i=1; i<pts.length; i++) {
      const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y
      len.push(len[i-1]+Math.sqrt(dx*dx+dy*dy))
    }
    const total = len[len.length-1]
    if (total===0) return pts.slice(0,n)
    const out: Px[] = []
    let j = 0
    for (let i=0; i<n; i++) {
      const tgt = (i/n)*total
      while (j<len.length-2 && len[j+1]<tgt) j++
      const span=len[j+1]-len[j], t=span>0?(tgt-len[j])/span:0
      out.push({ x:pts[j].x+t*(pts[j+1].x-pts[j].x), y:pts[j].y+t*(pts[j+1].y-pts[j].y) })
    }
    return out
  }

  // ── Signal processing ────────────────────────────────────────────

  private _gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
    const k=[0.0545,0.2442,0.4026,0.2442,0.0545], tmp=new Float32Array(W*H), out=new Float32Array(W*H)
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=src[y*W+Math.max(0,Math.min(W-1,x+d))]*k[d+2]; tmp[y*W+x]=s }
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      let s=0; for (let d=-2;d<=2;d++) s+=tmp[Math.max(0,Math.min(H-1,y+d))*W+x]*k[d+2]; out[y*W+x]=s }
    return out
  }

  private _sobel(src: Float32Array, W: number, H: number): Float32Array {
    const out=new Float32Array(W*H)
    for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
      const a=src[(y-1)*W+(x-1)],b=src[(y-1)*W+x],c=src[(y-1)*W+(x+1)]
      const d=src[y*W+(x-1)],f=src[y*W+(x+1)]
      const g=src[(y+1)*W+(x-1)],h=src[(y+1)*W+x],j=src[(y+1)*W+(x+1)]
      const gx=-a-2*d-g+c+2*f+j, gy=-a-2*b-c+g+2*h+j
      out[y*W+x]=Math.sqrt(gx*gx+gy*gy)
    }
    return out
  }

  private _smoothPoints(pts: Point[], passes: number): Point[] {
    let cur=pts.slice()
    for (let p=0;p<passes;p++) {
      const n=cur.length, next:Point[]=[]
      for (let i=0;i<n;i++) { const a=cur[(i-1+n)%n],b=cur[i],c=cur[(i+1)%n]
        next.push({x:(a.x+2*b.x+c.x)/4,y:(a.y+2*b.y+c.y)/4}) }
      cur=next
    }
    return cur
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._controlPoints.length < 3) return
    ctx.save()
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i=0;i<=RENDER_PTS;i++) {
      const p=sampleSpline(i/RENDER_PTS,this._controlPoints)
      if (i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y)
    }
    ctx.closePath(); ctx.stroke()
    ctx.fillStyle = ACCENT
    for (const cp of this._controlPoints) { ctx.beginPath(); ctx.arc(cp.x,cp.y,2.5,0,Math.PI*2); ctx.fill() }
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width<=0||this.bounds.height<=0) return
    this._drawPill(ctx, this.bounds)
    const cp={x:300,y:50,width:260,height:this.bounds.height}
    this._cpBounds=cp; this._drawPill(ctx,cp)
  }

  private _drawPill(ctx: Ctx2D, b: {x:number;y:number;width:number;height:number}): void {
    const {x,y,width,height}=b, midY=y+height/2
    const btnB=this._detectBtnBounds(b)
    const sliderW=Math.max(0,btnB.x-(x+10)-LABEL_W-8)
    this._numPtsSlider.bounds={x:x+10,y:y+6,width:sliderW,height:Math.max(0,height-12)}
    this._numPtsSlider.interactive=true; this._numPtsSlider.displayValue=this._numPtsSlider.value
    ctx.save()
    ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.beginPath()
    ctx.roundRect(x,y,width,height,Math.min(height/2,8)); ctx.fill()
    ctx.fillStyle=ACCENT; ctx.beginPath(); ctx.roundRect(x,y,4,height,[4,0,0,4]); ctx.fill()
    this._numPtsSlider.renderSelf(ctx)
    const n=this._numPoints()
    ctx.font='11px monospace'; ctx.textAlign='left'; ctx.textBaseline='middle'
    ctx.fillStyle=this._controlPoints.length>0?'rgba(255,255,255,0.80)':'rgba(255,255,255,0.35)'
    ctx.fillText(this._controlPoints.length>0?`${n} pts`:this.imageSlot.isActive?'…':'—',
                 x+10+sliderW+4, midY)
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
      this._forceDetect=true; this.markDirty(); return true }
    return false
  }

  protected override hitTestSelf(point: Point) { return this._numPtsSlider.hitTest(point) }

  private _detectBtnBounds(b: {x:number;y:number;width:number;height:number}) {
    return {x:b.x+b.width-BTN_M-BTN_W, y:b.y+(b.height-BTN_H)/2, width:BTN_W, height:BTN_H}
  }
}
