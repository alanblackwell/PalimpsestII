// Shared CAMShift-style colour tracking for TrackXxxLayer classes.
// Composition, not inheritance — each Track layer holds one instance.
//
// Algorithm: build a normalised 32-bin hue histogram from the initialisation
// mask, then each frame compute a back-projection probability map in a search
// window around the previous centroid and move to the weighted centroid.

import type { Point, Ctx2D } from '../core/types.js'

const HUE_BINS      = 32
const MAX_ITER      = 10    // mean-shift iteration cap
const CONVERGE_PX   = 1     // stop when centroid shifts less than this
const CROSSHAIR_R   = 14
const CROSSHAIR_COL = '#cf7ecf'   // Point accent

function rgbToHueBin(r: number, g: number, b: number): number {
  const max   = r > g ? (r > b ? r : b) : (g > b ? g : b)
  const min   = r < g ? (r < b ? r : b) : (g < b ? g : b)
  const delta = max - min
  if (delta < 15) return -1   // achromatic — ignore
  let h: number
  if (max === r)      h = (g - b) / delta
  else if (max === g) h = 2 + (b - r) / delta
  else                h = 4 + (r - g) / delta
  return Math.floor((((h / 6) % 1 + 1) % 1) * HUE_BINS)
}

export class MotionTrackerCore {
  private _histogram    = new Float32Array(HUE_BINS)
  private _frozenFrame: OffscreenCanvas | null = null
  private _trackedPoint: Point = { x: 0, y: 0 }
  private _hasCapture   = false

  get hasCapture(): boolean { return this._hasCapture }
  getPoint(): Point         { return { ...this._trackedPoint } }
  getFrozenFrame(): OffscreenCanvas | null { return this._frozenFrame }

  // ----------------------------------------------------------
  // Algorithm
  // ----------------------------------------------------------

  // Sample the hue histogram from `image` inside `mask`, freeze a copy of
  // the frame, and set the initial tracked point to `initPoint`.
  capture(
    image:     OffscreenCanvas | ImageBitmap,
    mask:      OffscreenCanvas | null,
    initPoint: Point,
  ): void {
    const iw = image.width, ih = image.height

    const ff = new OffscreenCanvas(iw, ih)
    ff.getContext('2d')!.drawImage(image, 0, 0)
    this._frozenFrame = ff

    const imgData  = this._readRegion(image, 0, 0, iw, ih)
    if (!imgData) return
    const maskData = mask?.getContext('2d')?.getImageData(0, 0, mask.width, mask.height) ?? null

    const hist  = new Float32Array(HUE_BINS)
    let   total = 0
    for (let py = 0; py < ih; py++) {
      for (let px = 0; px < iw; px++) {
        const i = (py * iw + px) * 4
        if (maskData && maskData.data[i + 3]! < 128) continue
        const bin = rgbToHueBin(imgData.data[i]!, imgData.data[i + 1]!, imgData.data[i + 2]!)
        if (bin >= 0) { hist[bin] = (hist[bin] ?? 0) + 1; total++ }
      }
    }
    if (total > 0) for (let b = 0; b < HUE_BINS; b++) hist[b] = (hist[b] ?? 0) / total

    this._histogram    = hist
    this._trackedPoint = { ...initPoint }
    this._hasCapture   = true
  }

  // Compute a new tracked point using mean-shift: iteratively re-centre a
  // search window on the back-projection centroid until convergence.  Starting
  // from the current position (which after a re-capture is the mask centre),
  // this converges to the *nearest* local colour mode rather than the global
  // weighted mean, preventing the result from jumping to a background region
  // that shares the target hue.
  track(image: OffscreenCanvas | ImageBitmap, searchRadius: number): Point[] {
    if (!this._hasCapture) return []
    const iw = image.width, ih = image.height
    const hist = this._histogram
    const history: Point[] = []

    let cx = this._trackedPoint.x
    let cy = this._trackedPoint.y

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const x0 = Math.max(0, Math.floor(cx - searchRadius))
      const y0 = Math.max(0, Math.floor(cy - searchRadius))
      const x1 = Math.min(iw, Math.ceil(cx + searchRadius))
      const y1 = Math.min(ih, Math.ceil(cy + searchRadius))
      const sw = x1 - x0, sh = y1 - y0
      if (sw <= 0 || sh <= 0) break

      const data = this._readRegion(image, x0, y0, sw, sh)
      if (!data) break

      let wx = 0, wy = 0, wSum = 0
      for (let dy = 0; dy < sh; dy++) {
        for (let dx = 0; dx < sw; dx++) {
          const i = (dy * sw + dx) * 4
          const bin = rgbToHueBin(data.data[i]!, data.data[i + 1]!, data.data[i + 2]!)
          const w   = bin >= 0 ? hist[bin]! : 0
          if (w > 0) { wx += (x0 + dx) * w; wy += (y0 + dy) * w; wSum += w }
        }
      }
      if (wSum === 0) break

      const nx = wx / wSum, ny = wy / wSum
      const shift = Math.hypot(nx - cx, ny - cy)
      cx = nx; cy = ny
      history.push({ x: cx, y: cy })
      if (shift < CONVERGE_PX) break
    }

    this._trackedPoint = { x: cx, y: cy }
    return history
  }

  // ----------------------------------------------------------
  // Rendering helpers (called from the host layer)
  // ----------------------------------------------------------

  renderFrozenFrame(ctx: Ctx2D, opacity: number): void {
    if (!this._frozenFrame) return
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.drawImage(this._frozenFrame, 0, 0)
    ctx.restore()
  }

  renderTrackedPoint(ctx: Ctx2D, override?: Point): void {
    if (!this._hasCapture) return
    const { x, y } = override ?? this._trackedPoint
    const r = CROSSHAIR_R
    ctx.save()
    ctx.strokeStyle = CROSSHAIR_COL
    ctx.lineWidth   = 1.5
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur  = 3
    ctx.beginPath()
    ctx.moveTo(x - r, y); ctx.lineTo(x + r, y)
    ctx.moveTo(x, y - r); ctx.lineTo(x, y + r)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ----------------------------------------------------------
  // Persistence (frozen frame is not persisted; tracking resumes
  // from the stored histogram + last known point on reload)
  // ----------------------------------------------------------

  serializeState(): Record<string, unknown> {
    return {
      histogram:    Array.from(this._histogram),
      trackedPoint: { ...this._trackedPoint },
      hasCapture:   this._hasCapture,
    }
  }

  deserializeState(s: Record<string, unknown>): void {
    if (Array.isArray(s.histogram)) {
      const h = new Float32Array(HUE_BINS)
      for (let i = 0; i < HUE_BINS && i < (s.histogram as number[]).length; i++)
        h[i] = (s.histogram as number[])[i]!
      this._histogram = h
    }
    if (s.trackedPoint && typeof (s.trackedPoint as Point).x === 'number')
      this._trackedPoint = s.trackedPoint as Point
    if (typeof s.hasCapture === 'boolean')
      this._hasCapture = s.hasCapture
  }

  // ----------------------------------------------------------
  // Private
  // ----------------------------------------------------------

  private _readRegion(
    image: OffscreenCanvas | ImageBitmap,
    x: number, y: number, w: number, h: number,
  ): ImageData | null {
    if (image instanceof OffscreenCanvas) {
      return image.getContext('2d')?.getImageData(x, y, w, h) ?? null
    }
    // ImageBitmap: draw the crop into a small temp canvas then read it
    const tmp = new OffscreenCanvas(w, h)
    tmp.getContext('2d')!.drawImage(image, x, y, w, h, 0, 0, w, h)
    return tmp.getContext('2d')!.getImageData(0, 0, w, h)
  }
}
