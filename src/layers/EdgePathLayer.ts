import { Layer }          from '../core/Layer.js'
import { ParameterSlot }  from '../core/ParameterSlot.js'
import {
  ValueType,
  type Amount, type AmountSource,
  type ImageValue, type ImageSource,
  type Point,   type PointSource,
  type Ctx2D,
} from '../core/types.js'
import { graph }         from '../dataflow/Graph.js'
import { SliderRegion }  from '../regions/SliderRegion.js'

// ------------------------------------------------------------
// EdgePathLayer — derives a closed Catmull-Rom path from an image
// ------------------------------------------------------------
//
// Algorithm (no machine learning):
//
//   1. Read the image bitmap via OffscreenCanvas.  A working copy is
//      scaled to at most PROC_SIZE × PROC_SIZE for performance.
//
//   2. Convert to greyscale, apply a separable Gaussian blur (σ ≈ 1.4,
//      5-tap kernel) to suppress noise.
//
//   3. Compute a Sobel edge-magnitude map.
//
//   4. Set an adaptive threshold at the 65th percentile of non-zero
//      edge values.  This is high enough to ignore diffuse texture
//      while still capturing the dominant object boundary.
//
//   5. Cast numPoints rays outward from the image centre.  On each ray,
//      walk from the outer margin inward and take the first pixel whose
//      edge magnitude exceeds the threshold.  This finds the outermost
//      strong boundary on each radial line — typically the silhouette
//      of the main subject.  If no edge exceeds the threshold on a ray,
//      fall back to the pixel of peak edge magnitude; if that too is
//      near zero, place a point on a default ellipse.
//
//   6. Smooth the resulting control-point ring with a few passes of
//      binomial (1-2-1) averaging, which removes per-ray jitter while
//      preserving the overall shape.
//
//   7. Store points in image-pixel space.  samplePerimeter() and
//      renderSelf() transform them into canvas space via positionSlot
//      (centres image at that point, default 400 × 300) and scaleSlot
//      (maps Amount → MIN_SCALE … MAX_SCALE, default 1.0 = natural
//      image pixels).  Binding positionSlot and scaleSlot to the same
//      sources as the backing ImageLayer keeps the path in register.
//
// Inputs:
//   imageSlot    (Image)  — source bitmap
//   phaseSlot    (Amount) — position along perimeter [0, 1]
//   positionSlot (Point)  — canvas anchor (image centre); default 400,300
//   scaleSlot    (Amount) — display scale mapped to [0.05, 4.0]
//
// Panel: slider controls numPoints (4 – 32, default 10).
//
// Output: PointSource (getPoint + samplePerimeter), type Point.
//         Implements duck-typed samplePerimeter so AnimPathLayer can
//         use this layer as a shape.
//
// Visual layout:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ ▌  [──────⬤────]    10 pts              path        │
//   └──────────────────────────────────────────────────────┘

const ACCENT     = '#cf9f7e'
const MIN_POINTS = 4
const MAX_POINTS = 32
const DEF_POINTS = 10
const PROC_SIZE  = 400   // max dimension for edge-detection working copy
const RENDER_PTS = 200   // Catmull-Rom render segments
const MIN_SCALE  = 0.05
const MAX_SCALE  = 4.0
const DEFAULT_POS: Point = { x: 400, y: 300 }

const LABEL_W = 76   // reserved width for text on right of slider

// ── Catmull-Rom helpers (same formula as PathLayer) ──────────────

function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  )
}

function sampleSpline(t: number, pts: Point[]): Point {
  const n = pts.length
  const s = (((t % 1) + 1) % 1) * n
  const i = Math.floor(s)
  const u = s - i
  const p0 = pts[(i - 1 + n) % n]
  const p1 = pts[i]
  const p2 = pts[(i + 1) % n]
  const p3 = pts[(i + 2) % n]
  return {
    x: catmullRom(u, p0.x, p1.x, p2.x, p3.x),
    y: catmullRom(u, p0.y, p1.y, p2.y, p3.y),
  }
}

// ── EdgePathLayer ────────────────────────────────────────────────

export class EdgePathLayer extends Layer implements PointSource {
  readonly types: ReadonlySet<ValueType> = new Set([ValueType.Point])

  readonly imageSlot:    ParameterSlot
  readonly phaseSlot:    ParameterSlot
  readonly positionSlot: ParameterSlot
  readonly scaleSlot:    ParameterSlot

  private readonly _numPtsSlider: SliderRegion

  private _phase:         number = 0
  private _position:      Point  = { ...DEFAULT_POS }
  private _scale:         number = 1.0
  private _controlPoints: Point[] = []  // image-pixel coordinates
  private _imgW:          number = 0
  private _imgH:          number = 0
  private _lastBitmap:    ImageValue = null
  private _lastNumPts:    number = DEF_POINTS
  private _cpBounds: { x: number; y: number; width: number; height: number } | null = null

  constructor() {
    super()
    this.imageSlot    = new ParameterSlot(ValueType.Image,  this, 'image')
    this.phaseSlot    = new ParameterSlot(ValueType.Amount, this, 'phase')
    this.positionSlot = new ParameterSlot(ValueType.Point,  this, 'position')
    this.scaleSlot    = new ParameterSlot(ValueType.Amount, this, 'scale')
    const initV = (DEF_POINTS - MIN_POINTS) / (MAX_POINTS - MIN_POINTS)
    this._numPtsSlider = new SliderRegion(this, initV)
    this.slots.push(this.imageSlot, this.phaseSlot, this.positionSlot, this.scaleSlot)
    this.debugName = 'EdgePath'
    graph.register(this)
  }

  // ── PointSource ─────────────────────────────────────────────────

  getPoint(): Point {
    if (this._controlPoints.length < 2) return { ...this._position }
    return this._toCanvas(sampleSpline(this._phase, this._controlPoints))
  }

  // Duck-typed samplePerimeter: lets AnimPathLayer use this as a shape.
  samplePerimeter(t: number): Point {
    if (this._controlPoints.length < 2) return { ...this._position }
    return this._toCanvas(sampleSpline(t, this._controlPoints))
  }

  // ── SliderRegion callback ────────────────────────────────────────

  setValue(_v: Amount): void {
    // SliderRegion calls this on drag; we re-read the slider value in
    // recompute() so just marking dirty is sufficient.
    this.markDirty()
  }

  // ── Node ─────────────────────────────────────────────────────────

  protected recompute(): void {
    this._position = this.positionSlot.isActive
      ? (this.positionSlot.source as PointSource).getPoint()
      : { ...DEFAULT_POS }

    if (this.scaleSlot.isActive) {
      const t = (this.scaleSlot.source as AmountSource).getAmount() as Amount
      this._scale = MIN_SCALE + t * (MAX_SCALE - MIN_SCALE)
    } else {
      this._scale = 1.0
    }

    if (this.phaseSlot.isActive) {
      this._phase = (this.phaseSlot.source as AmountSource).getAmount() as Amount
    }

    const numPts = this._numPoints()
    if (this.imageSlot.isActive) {
      const bitmap = (this.imageSlot.source as ImageSource).getImage()
      if (bitmap !== null && (bitmap !== this._lastBitmap || numPts !== this._lastNumPts)) {
        this._lastBitmap = bitmap
        this._lastNumPts = numPts
        this._detectPath(bitmap, numPts)
      }
    } else if (this._lastBitmap !== null) {
      this._lastBitmap    = null
      this._controlPoints = []
    }
  }

  // ── Edge detection ───────────────────────────────────────────────

  private _numPoints(): number {
    return Math.round(MIN_POINTS + this._numPtsSlider.value * (MAX_POINTS - MIN_POINTS))
  }

  private _detectPath(bitmap: ImageBitmap, numPts: number): void {
    // Scale to at most PROC_SIZE for performance, preserving aspect.
    const aspect = bitmap.width / bitmap.height
    const pw = aspect >= 1
      ? PROC_SIZE
      : Math.round(PROC_SIZE * aspect)
    const ph = aspect >= 1
      ? Math.round(PROC_SIZE / aspect)
      : PROC_SIZE

    this._imgW = bitmap.width
    this._imgH = bitmap.height

    // Read pixel data.
    const osc  = new OffscreenCanvas(pw, ph)
    const octx = osc.getContext('2d')!
    octx.drawImage(bitmap, 0, 0, pw, ph)
    const { data } = octx.getImageData(0, 0, pw, ph)

    // Greyscale.
    const gray = new Float32Array(pw * ph)
    for (let i = 0; i < pw * ph; i++) {
      gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255
    }

    // Gaussian blur (separable 5-tap, σ ≈ 1.4).
    const blurred = this._gaussBlur(gray, pw, ph)

    // Sobel edge magnitude.
    const edges = this._sobel(blurred, pw, ph)

    // Adaptive threshold: 65th percentile of non-zero edge values.
    const nonzero: number[] = []
    for (const v of edges) { if (v > 0) nonzero.push(v) }
    nonzero.sort((a, b) => a - b)
    const threshold = nonzero.length > 0 ? nonzero[Math.floor(nonzero.length * 0.65)] : 0

    // Radial sampling.
    const cx = pw / 2, cy = ph / 2
    const maxR   = Math.min(pw, ph) * 0.47  // stay clear of padding
    const minR   = maxR * 0.08
    const scaleX = bitmap.width  / pw
    const scaleY = bitmap.height / ph

    const pts: Point[] = []

    for (let i = 0; i < numPts; i++) {
      // Angles start at 12 o'clock, run clockwise.
      const angle = (i / numPts) * Math.PI * 2 - Math.PI / 2
      const dx = Math.cos(angle), dy = Math.sin(angle)

      let found: { x: number; y: number } | null = null
      let peakVal = 0
      let peakPt: { x: number; y: number } | null = null

      // Walk from outer margin inward — find first edge above threshold
      // (outermost strong boundary = silhouette of main subject).
      for (let r = maxR; r >= minR; r -= 0.5) {
        const px = cx + dx * r
        const py = cy + dy * r
        const ix = Math.round(px), iy = Math.round(py)
        if (ix < 1 || iy < 1 || ix >= pw - 1 || iy >= ph - 1) continue
        const e = edges[iy * pw + ix]
        if (e > peakVal) { peakVal = e; peakPt = { x: px, y: py } }
        if (found === null && e >= threshold) found = { x: px, y: py }
      }

      // Fallbacks: peak magnitude → default ellipse.
      const pt = found ?? peakPt ?? { x: cx + dx * maxR * 0.65, y: cy + dy * maxR * 0.65 }
      pts.push({ x: pt.x * scaleX, y: pt.y * scaleY })
    }

    // Smooth control points — binomial (1-2-1) passes reduce ray-to-ray jitter.
    this._controlPoints = this._smoothPoints(pts, 3)
  }

  private _gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
    const k   = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
    const tmp = new Float32Array(W * H)
    const out = new Float32Array(W * H)
    // Horizontal pass.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let d = -2; d <= 2; d++)
          s += src[y * W + Math.max(0, Math.min(W - 1, x + d))] * k[d + 2]
        tmp[y * W + x] = s
      }
    }
    // Vertical pass.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0
        for (let d = -2; d <= 2; d++)
          s += tmp[Math.max(0, Math.min(H - 1, y + d)) * W + x] * k[d + 2]
        out[y * W + x] = s
      }
    }
    return out
  }

  private _sobel(src: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H)
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const a = src[(y-1)*W+(x-1)], b = src[(y-1)*W+x], c = src[(y-1)*W+(x+1)]
        const d = src[ y   *W+(x-1)],                      f = src[ y   *W+(x+1)]
        const g = src[(y+1)*W+(x-1)], h = src[(y+1)*W+x], j = src[(y+1)*W+(x+1)]
        const gx = -a - 2*d - g + c + 2*f + j
        const gy = -a - 2*b - c + g + 2*h + j
        out[y * W + x] = Math.sqrt(gx*gx + gy*gy)
      }
    }
    return out
  }

  private _smoothPoints(pts: Point[], passes: number): Point[] {
    let cur = pts.slice()
    for (let p = 0; p < passes; p++) {
      const n = cur.length
      const next: Point[] = []
      for (let i = 0; i < n; i++) {
        const a = cur[(i - 1 + n) % n]
        const b = cur[i]
        const c = cur[(i + 1) % n]
        next.push({ x: (a.x + 2*b.x + c.x) / 4, y: (a.y + 2*b.y + c.y) / 4 })
      }
      cur = next
    }
    return cur
  }

  // ── Coordinate transform ─────────────────────────────────────────

  // Image-pixel coords → canvas coords.
  // The image centre (imgW/2, imgH/2) maps to this._position.
  private _toCanvas(p: Point): Point {
    return {
      x: this._position.x + (p.x - this._imgW / 2) * this._scale,
      y: this._position.y + (p.y - this._imgH / 2) * this._scale,
    }
  }

  // ── Rendering ────────────────────────────────────────────────────

  renderSelf(ctx: Ctx2D): void {
    if (this._controlPoints.length < 3) return

    ctx.save()

    // Closed spline path.
    ctx.strokeStyle = ACCENT
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    for (let i = 0; i <= RENDER_PTS; i++) {
      const p = this._toCanvas(sampleSpline(i / RENDER_PTS, this._controlPoints))
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.stroke()

    // Control-point dots.
    ctx.fillStyle = ACCENT
    for (const cp of this._controlPoints) {
      const cv = this._toCanvas(cp)
      ctx.beginPath()
      ctx.arc(cv.x, cv.y, 2.5, 0, Math.PI * 2)
      ctx.fill()
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

  // ── Panel pill ───────────────────────────────────────────────────

  private _drawPill(ctx: Ctx2D, b: { x: number; y: number; width: number; height: number }): void {
    const { x, y, width, height } = b
    const midY   = y + height / 2
    const sliderW = Math.max(0, width - 10 - LABEL_W - 4)

    // Sync slider bounds to this pill.
    this._numPtsSlider.bounds = {
      x: x + 10, y: y + 6,
      width: sliderW, height: Math.max(0, height - 12),
    }
    this._numPtsSlider.interactive  = true
    this._numPtsSlider.displayValue = this._numPtsSlider.value

    ctx.save()

    // Background.
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, Math.min(height / 2, 8))
    ctx.fill()

    // Accent stripe.
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.roundRect(x, y, 4, height, [4, 0, 0, 4])
    ctx.fill()

    // Slider.
    this._numPtsSlider.renderSelf(ctx)

    // Label: point count and status.
    const n   = this._numPoints()
    const has = this._controlPoints.length > 0
    const statusLeft = has ? `${n} pts` : (this.imageSlot.isActive ? 'detecting…' : 'no image')
    const labelX = x + 10 + sliderW + 8
    ctx.font         = '11px monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = has ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.35)'
    ctx.fillText(statusLeft, labelX, midY)

    ctx.restore()
  }

  // ── Hit testing ──────────────────────────────────────────────────

  protected override hitTestSelf(point: Point) {
    return this._numPtsSlider.hitTest(point)
  }
}
