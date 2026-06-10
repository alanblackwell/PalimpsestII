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
// Pipeline (three phases):
//
//   Phase 1 — Radial seed points
//     Cast numPoints rays outward from the processing-space centre, one
//     per angle around the full circle.  On each ray walk from the outer
//     margin inward; stop at the first pixel whose Sobel magnitude exceeds
//     the adaptive threshold (65th percentile of non-zero values).  This
//     gives numPoints rough waypoints distributed around the dominant
//     boundary.  With a mask bound, only masked pixels are considered;
//     unmasked pixels are used as a fallback if no masked edge is found.
//
//   Phase 2 — Live Wire (Intelligent Scissors / Dijkstra)
//     Build a per-pixel cost: cost = 1 − normalised_edge_magnitude.
//     Strong edges cost nearly zero to traverse; flat regions cost ~1.
//     For each consecutive pair of seed points run Dijkstra's shortest-
//     path algorithm on the 8-connected pixel graph.  The resulting path
//     snaps to real edge curves between the seeds, handles concave shapes,
//     and cannot wander to irrelevant edges far from the seeds.  With a
//     mask, nodes outside the mask are excluded from the graph entirely,
//     further confining the search.  All N segment paths are concatenated
//     into a single dense pixel chain.
//
//   Phase 3 — Arc-length resample + Catmull-Rom
//     The dense chain is resampled at numPoints uniformly-spaced arc-
//     length positions, giving control points that lie on actual edges and
//     are evenly distributed around the perimeter.  A single pass of
//     binomial smoothing removes sub-pixel jitter.  The result is stored
//     as a closed Catmull-Rom spline.
//
// Coordinate system
//   ImageLayer.getImage() and MaskLayer.getMask() both return full-canvas
//   OffscreenCanvases already in canvas space.  No additional transform is
//   applied; samplePerimeter() returns canvas coordinates directly.
//
// Inputs:
//   imageSlot (Image)  — source bitmap (typically an ImageLayer)
//   maskSlot  (Mask)   — optional; confines Phase 1 and Phase 2 to the
//                        masked region
//   phaseSlot (Amount) — position along perimeter [0, 1]
//
// Panel: slider controls numPoints (4–32, default 10).
//        [DETECT] forces re-detection (useful after mask is repainted).
//
// Output: PointSource + samplePerimeter duck-type (AnimPathLayer-compatible)

const ACCENT     = '#cf9f7e'
const MIN_POINTS = 4
const MAX_POINTS = 32
const DEF_POINTS = 10
const PROC_SIZE  = 400    // max working-copy dimension (px)
const RENDER_PTS = 200    // Catmull-Rom render segments
const LABEL_W    = 46
const BTN_W      = 54
const BTN_H      = 22
const BTN_M      = 6

// ── Binary min-heap (paired Float32 / Int32 arrays) ──────────────
// Used by Dijkstra.  Lazy-deletion: re-push with lower cost rather
// than decrease-key; skip stale entries when popping.

class MinHeap {
  private _costs: Float32Array
  private _ids:   Int32Array
  private _n = 0

  constructor(cap = 8192) {
    this._costs = new Float32Array(cap)
    this._ids   = new Int32Array(cap)
  }

  get size(): number { return this._n }

  push(cost: number, id: number): void {
    if (this._n >= this._costs.length) {
      const nc = new Float32Array(this._costs.length * 2)
      const ni = new Int32Array(this._ids.length * 2)
      nc.set(this._costs); ni.set(this._ids)
      this._costs = nc; this._ids = ni
    }
    let i = this._n++
    this._costs[i] = cost; this._ids[i] = id
    // sift up
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this._costs[p] <= this._costs[i]) break
      this._swap(p, i); i = p
    }
  }

  pop(): { cost: number; id: number } | null {
    if (this._n === 0) return null
    const cost = this._costs[0], id = this._ids[0]
    this._n--
    if (this._n > 0) {
      this._costs[0] = this._costs[this._n]
      this._ids[0]   = this._ids[this._n]
      // sift down
      let i = 0
      while (true) {
        let m = i
        const l = 2*i+1, r = 2*i+2
        if (l < this._n && this._costs[l] < this._costs[m]) m = l
        if (r < this._n && this._costs[r] < this._costs[m]) m = r
        if (m === i) break
        this._swap(m, i); i = m
      }
    }
    return { cost, id }
  }

  private _swap(a: number, b: number): void {
    const tc = this._costs[a], ti = this._ids[a]
    this._costs[a] = this._costs[b]; this._ids[a] = this._ids[b]
    this._costs[b] = tc; this._ids[b] = ti
  }
}

// ── Catmull-Rom helpers ──────────────────────────────────────────

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2*p0 - 5*p1 + 4*p2 - p3) * t*t +
    (-p0 + 3*p1 - 3*p2 + p3) * t*t*t
  )
}

function sampleSpline(t: number, pts: Point[]): Point {
  const n = pts.length
  const s = (((t % 1) + 1) % 1) * n
  const i = Math.floor(s), u = s - i
  const p0 = pts[(i-1+n)%n], p1 = pts[i], p2 = pts[(i+1)%n], p3 = pts[(i+2)%n]
  return { x: catmullRom(u, p0.x, p1.x, p2.x, p3.x),
           y: catmullRom(u, p0.y, p1.y, p2.y, p3.y) }
}

// ── Pixel coordinate helpers ─────────────────────────────────────

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
  private _lastImageId:    object | null = null   // identity sentinel for cache
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

  // ── PointSource ─────────────────────────────────────────────────

  getPoint(): Point {
    if (this._controlPoints.length < 2) return { x: 0, y: 0 }
    return sampleSpline(this._phase, this._controlPoints)
  }

  samplePerimeter(t: number): Point {
    if (this._controlPoints.length < 2) return { x: 0, y: 0 }
    return sampleSpline(t, this._controlPoints)
  }

  // ── SliderRegion callback ────────────────────────────────────────

  setValue(_v: Amount): void { this.markDirty() }

  // ── Node ─────────────────────────────────────────────────────────

  protected recompute(): void {
    if (this.phaseSlot.isActive)
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount

    const numPts     = this._numPoints()
    const maskActive = this.maskSlot.isActive
    const imageVal   = this.imageSlot.isActive
      ? (this.imageSlot.source as ImageSource).getImage()
      : null
    const maskVal    = maskActive
      ? (this.maskSlot.source as MaskSource).getMask()
      : null

    // Use the OffscreenCanvas object identity as a cache key; a new
    // OffscreenCanvas is only allocated when the image reloads, so this
    // correctly detects image changes without pixel comparison.
    const imageId = imageVal as object | null

    const needsDetect =
      this._forceDetect          ||
      imageId !== this._lastImageId ||
      numPts  !== this._lastNumPts  ||
      maskActive !== this._lastMaskActive

    if (needsDetect && imageVal !== null) {
      this._lastImageId    = imageId
      this._lastNumPts     = numPts
      this._lastMaskActive = maskActive
      this._forceDetect    = false
      this._detectPath(imageVal, maskVal, numPts)
    } else if (imageVal === null && this._controlPoints.length > 0) {
      this._lastImageId   = null
      this._controlPoints = []
    }
  }

  // ── Detection pipeline ───────────────────────────────────────────

  private _numPoints(): number {
    return Math.round(MIN_POINTS + this._numPtsSlider.value * (MAX_POINTS - MIN_POINTS))
  }

  private _detectPath(
    imageSource: ImageBitmap | OffscreenCanvas,
    maskSource:  MaskValue,
    numPts:      number,
  ): void {
    const srcW = imageSource.width, srcH = imageSource.height
    const aspect = srcW / srcH
    const pw = aspect >= 1 ? PROC_SIZE : Math.round(PROC_SIZE * aspect)
    const ph = aspect >= 1 ? Math.round(PROC_SIZE / aspect) : PROC_SIZE

    // ── Greyscale → Gaussian blur → Sobel ─────────────────────────
    const imgOsc = new OffscreenCanvas(pw, ph)
    const imgCtx = imgOsc.getContext('2d')!
    imgCtx.drawImage(imageSource, 0, 0, pw, ph)
    const imgPx = imgCtx.getImageData(0, 0, pw, ph).data

    const gray = new Float32Array(pw * ph)
    for (let i = 0; i < pw * ph; i++)
      gray[i] = (0.299*imgPx[i*4] + 0.587*imgPx[i*4+1] + 0.114*imgPx[i*4+2]) / 255

    const edges = this._sobel(this._gaussBlur(gray, pw, ph), pw, ph)

    // ── Normalise edges; build cost map for Dijkstra ───────────────
    let maxEdge = 0
    for (const v of edges) if (v > maxEdge) maxEdge = v
    const cost = new Float32Array(pw * ph)
    if (maxEdge > 0)
      for (let i = 0; i < cost.length; i++) cost[i] = 1 - edges[i] / maxEdge
    else
      cost.fill(1)

    // Adaptive threshold for seed placement (65th percentile).
    const nonzero: number[] = []
    for (const v of edges) if (v > 0) nonzero.push(v)
    nonzero.sort((a, b) => a - b)
    const threshold = nonzero.length > 0 ? nonzero[Math.floor(nonzero.length * 0.65)] : 0

    // ── Mask pixel data ────────────────────────────────────────────
    let maskPx: Uint8ClampedArray | null = null
    if (maskSource !== null) {
      const mOsc = new OffscreenCanvas(pw, ph)
      const mCtx = mOsc.getContext('2d')!
      mCtx.drawImage(maskSource, 0, 0, pw, ph)
      maskPx = mCtx.getImageData(0, 0, pw, ph).data
    }

    // ── Phase 1: radial seeds (processing space) ───────────────────
    const seeds = this._radialSeeds(edges, maskPx, pw, ph, threshold, numPts)

    // ── Phase 2: Live Wire between consecutive seeds ───────────────
    const chain: Px[] = []
    for (let i = 0; i < numPts; i++) {
      const a = seeds[i], b = seeds[(i + 1) % numPts]
      const seg = this._liveWire(cost, maskPx, pw, ph, a, b)
      // Exclude last point of each segment (equals first of next).
      for (let j = 0; j < seg.length - 1; j++) chain.push(seg[j])
    }

    // ── Phase 3: uniform arc-length resample → N control points ────
    const resampled = this._uniformResample(chain, numPts)

    // Scale from processing space to canvas space and lightly smooth.
    const scaleX = srcW / pw, scaleY = srcH / ph
    this._controlPoints = this._smoothPoints(
      resampled.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })),
      1,
    )
  }

  // ── Phase 1: radial seed finder ──────────────────────────────────

  private _radialSeeds(
    edges:     Float32Array,
    mask:      Uint8ClampedArray | null,
    W:         number,
    H:         number,
    threshold: number,
    n:         number,
  ): Px[] {
    const cx = W / 2, cy = H / 2
    const maxR = Math.min(W, H) * 0.47
    const minR = maxR * 0.08
    const seeds: Px[] = []

    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2
      const dx = Math.cos(angle), dy = Math.sin(angle)

      let maskedHit: Px | null = null
      let anyHit:    Px | null = null
      let peakVal = 0, peakPt: Px | null = null

      for (let r = maxR; r >= minR; r -= 0.5) {
        const px = cx + dx * r, py = cy + dy * r
        const ix = Math.round(px), iy = Math.round(py)
        if (ix < 1 || iy < 1 || ix >= W-1 || iy >= H-1) continue

        const e      = edges[iy * W + ix]
        const inMask = mask === null || mask[(iy * W + ix) * 4 + 3] > 0

        if (e > peakVal && inMask) { peakVal = e; peakPt = { x: px, y: py } }
        if (inMask  && maskedHit === null && e >= threshold) maskedHit = { x: px, y: py }
        if (anyHit  === null            && e >= threshold) anyHit    = { x: px, y: py }
      }

      seeds.push(
        maskedHit ??
        (mask !== null ? anyHit : null) ??
        peakPt ??
        { x: cx + dx * maxR * 0.65, y: cy + dy * maxR * 0.65 },
      )
    }
    return seeds
  }

  // ── Phase 2: Dijkstra (Intelligent Scissors) ─────────────────────
  //
  // Finds the minimum-cost path from src to dst through the pixel graph.
  // cost[i] = 1 − normalised_edge_magnitude: strong edges are cheap.
  // Edge weight between neighbours = (cost_a + cost_b) / 2 * move_dist.
  // Pixels outside the mask are excluded from the graph when mask is set.
  // Returns a list of pixel-centre coordinates from src to dst inclusive.

  private _liveWire(
    cost: Float32Array,
    mask: Uint8ClampedArray | null,
    W:    number,
    H:    number,
    src:  Px,
    dst:  Px,
  ): Px[] {
    const N   = W * H
    const si  = Math.round(src.x), sj = Math.round(src.y)
    const di  = Math.round(dst.x), dj = Math.round(dst.y)
    const sid = sj * W + si
    const did = dj * W + di

    if (sid === did) return [{ x: si, y: sj }]

    const dist    = new Float32Array(N).fill(Infinity)
    const prev    = new Int32Array(N).fill(-1)
    const visited = new Uint8Array(N)
    dist[sid] = 0

    const heap = new MinHeap(Math.min(N, 16384))
    heap.push(0, sid)

    // 8-connected neighbours: [dx, dy, move_distance]
    const DIRS: [number, number, number][] = [
      [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
      [-1,-1, Math.SQRT2], [1,-1, Math.SQRT2],
      [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2],
    ]

    while (heap.size > 0) {
      const top = heap.pop()!
      if (top.cost > dist[top.id]) continue  // stale entry
      if (visited[top.id]) continue
      visited[top.id] = 1

      if (top.id === did) break

      const x = top.id % W, y = (top.id / W) | 0

      for (const [dx, dy, moveDist] of DIRS) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const nid = ny * W + nx
        if (visited[nid]) continue
        if (mask !== null && mask[nid * 4 + 3] < 10) continue

        const w       = (cost[top.id] + cost[nid]) * 0.5 * moveDist
        const newDist = dist[top.id] + w
        if (newDist < dist[nid]) {
          dist[nid] = newDist
          prev[nid] = top.id
          heap.push(newDist, nid)
        }
      }
    }

    // Back-trace from dst → src.
    const path: Px[] = []
    let cur = did
    while (cur !== -1 && path.length <= N) {
      path.push({ x: cur % W, y: (cur / W) | 0 })
      if (cur === sid) break
      cur = prev[cur]
    }

    // If the target was unreachable, return a straight-line fallback.
    if (path.length === 0 || path[path.length - 1].x !== si || path[path.length - 1].y !== sj) {
      return [{ x: si, y: sj }, { x: di, y: dj }]
    }

    path.reverse()
    return path
  }

  // ── Phase 3: uniform arc-length resampler ────────────────────────

  private _uniformResample(pts: Px[], n: number): Px[] {
    if (pts.length === 0) return []
    if (pts.length === 1) return Array(n).fill(pts[0])

    // Cumulative arc lengths.
    const len = [0]
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y
      len.push(len[i-1] + Math.sqrt(dx*dx + dy*dy))
    }
    const total = len[len.length - 1]
    if (total === 0) return pts.slice(0, n)

    const result: Px[] = []
    let j = 0
    for (let i = 0; i < n; i++) {
      const target = (i / n) * total
      while (j < len.length - 2 && len[j + 1] < target) j++
      const span = len[j + 1] - len[j]
      const t    = span > 0 ? (target - len[j]) / span : 0
      result.push({
        x: pts[j].x + t * (pts[j+1].x - pts[j].x),
        y: pts[j].y + t * (pts[j+1].y - pts[j].y),
      })
    }
    return result
  }

  // ── Signal processing ────────────────────────────────────────────

  private _gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
    const k = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
    const tmp = new Float32Array(W * H)
    const out = new Float32Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let d = -2; d <= 2; d++)
          s += src[y*W + Math.max(0, Math.min(W-1, x+d))] * k[d+2]
        tmp[y*W+x] = s
      }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let d = -2; d <= 2; d++)
          s += tmp[Math.max(0, Math.min(H-1, y+d))*W+x] * k[d+2]
        out[y*W+x] = s
      }
    return out
  }

  private _sobel(src: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H)
    for (let y = 1; y < H-1; y++)
      for (let x = 1; x < W-1; x++) {
        const a=src[(y-1)*W+(x-1)], b=src[(y-1)*W+x], c=src[(y-1)*W+(x+1)]
        const d=src[y*W+(x-1)],                        f=src[y*W+(x+1)]
        const g=src[(y+1)*W+(x-1)], h=src[(y+1)*W+x], j=src[(y+1)*W+(x+1)]
        const gx = -a - 2*d - g + c + 2*f + j
        const gy = -a - 2*b - c + g + 2*h + j
        out[y*W+x] = Math.sqrt(gx*gx + gy*gy)
      }
    return out
  }

  private _smoothPoints(pts: Point[], passes: number): Point[] {
    let cur = pts.slice()
    for (let p = 0; p < passes; p++) {
      const n = cur.length
      const next: Point[] = []
      for (let i = 0; i < n; i++) {
        const a = cur[(i-1+n)%n], b = cur[i], c = cur[(i+1)%n]
        next.push({ x: (a.x + 2*b.x + c.x) / 4, y: (a.y + 2*b.y + c.y) / 4 })
      }
      cur = next
    }
    return cur
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._controlPoints.length < 3) return
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = sampleSpline(i / RENDER_PTS, this._controlPoints)
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.stroke()
    ctx.fillStyle = ACCENT
    for (const cp of this._controlPoints) {
      ctx.beginPath(); ctx.arc(cp.x, cp.y, 2.5, 0, Math.PI * 2); ctx.fill()
    }
    ctx.restore()
  }

  renderPanel(ctx: Ctx2D): void {
    if (this.bounds.width <= 0 || this.bounds.height <= 0) return
    this._drawPill(ctx, this.bounds)
    const cp = { x: 300, y: 50, width: 260, height: this.bounds.height }
    this._cpBounds = cp
    this._drawPill(ctx, cp)
  }

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY    = y + height / 2
    const btnB    = this._detectBtnBounds(b)
    const sliderW = Math.max(0, btnB.x - (x + 10) - LABEL_W - 8)

    this._numPtsSlider.bounds = {
      x: x + 10, y: y + 6,
      width: sliderW, height: Math.max(0, height - 12),
    }
    this._numPtsSlider.interactive  = true
    this._numPtsSlider.displayValue = this._numPtsSlider.value

    ctx.save()

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    this._numPtsSlider.renderSelf(ctx)

    // Status label
    const n = this._numPoints()
    const statusText = this._controlPoints.length > 0
      ? `${n} pts`
      : this.imageSlot.isActive ? '…' : '—'
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = this._controlPoints.length > 0
      ? 'rgba(255,255,255,0.80)'
      : 'rgba(255,255,255,0.35)'
    ctx.fillText(statusText, x + 10 + sliderW + 4, midY)

    // DETECT button
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.beginPath()
    ctx.roundRect(btnB.x, btnB.y, btnB.width, btnB.height, 4)
    ctx.fill()
    ctx.font         = 'bold 10px monospace'
    ctx.fillStyle    = ACCENT
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('DETECT', btnB.x + btnB.width / 2, btnB.y + btnB.height / 2)

    ctx.restore()
  }

  // ── Interaction ──────────────────────────────────────────────────

  handlePointerDown(point: Point): boolean {
    const b = this._cpBounds ?? this.bounds
    if (boundingBoxContains(this._detectBtnBounds(b), point)) {
      this._forceDetect = true
      this.markDirty()
      return true
    }
    return false
  }

  protected override hitTestSelf(point: Point) {
    return this._numPtsSlider.hitTest(point)
  }

  private _detectBtnBounds(b: { x: number; y: number; width: number; height: number }) {
    return { x: b.x + b.width - BTN_M - BTN_W, y: b.y + (b.height - BTN_H) / 2,
             width: BTN_W, height: BTN_H }
  }
}
