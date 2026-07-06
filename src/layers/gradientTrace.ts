// gradientTrace.ts — radial gradient-search path detection.
//
// Two-pass algorithm:
//   Pass 1 — for each of numRays equally-spaced rays from the centroid,
//     smooth salience (luma+chroma) with a box filter, then find the sample
//     whose |gradient| × weight is maximum. Record that sample's fractional
//     position along the ray (maxProp ∈ [0,1]).
//   Mean — compute meanProp = average of all maxProp values; this is the
//     "characteristic radius" as a fraction of the centroid-to-boundary distance.
//   Pass 2 — re-score each sample with weight × circWeight, where circWeight
//     peaks near (or away from) meanProp according to circBias.
//
// Weight per sample:
//   Without stroke bound: radialWeight — biases toward centroid or boundary.
//   With stroke bound: Gaussian proximity to where the ray crosses the filled
//     stroke/path region. The same weight applies whether the sample is inside
//     or outside the boundary. circWeight is not applied when stroke is bound
//     (the crossing gives a per-ray boundary estimate directly).
//
// When strokeSrc is provided it must be a filled white canvas of the path/stroke
// interior (see TraceLayer._buildStrokeCanvas). The centroid is derived from
// those filled pixels; each ray finds its crossing as the last sample inside
// the filled region.
//
// radialBias ∈ [0,1]:
//   Stroke bound  — 0 = no proximity weighting (pure gradient magnitude);
//                   1 = crossing sample always wins (full Gaussian sharpness).
//   No stroke     — 0 = weight toward centroid, 0.5 = neutral, 1 = toward boundary.
// circBias   ∈ [0,1]: 0 = weight away from mean (spread), 0.5 = neutral, 1 = toward mean.
//   Only used when no stroke source is bound.

import type { Point } from '../core/types.js'

// gradMode 0 = luma only, 0.5 = current blend (luma + 0.35*chroma), 1 = chroma only
function salience(r: number, g: number, b: number, gradMode: number): number {
  const luma   = 0.299 * r + 0.587 * g + 0.114 * b
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  const wL = gradMode <= 0.5 ? 1 : 2 * (1 - gradMode)
  const wC = gradMode <= 0.5 ? 0.7 * gradMode : 0.35 + 1.3 * (gradMode - 0.5)
  return wL * luma + wC * chroma
}

// Weight that biases toward centroid (rBias<0) or boundary (rBias>0).
// p ∈ [0,1]: 0 = centroid end, 1 = boundary end. rBias ∈ [-1,1].
function radialWeight(p: number, rBias: number): number {
  return Math.max(0, 1 + rBias * (2 * p - 1))
}

// Weight that biases toward (cBias>0) or away from (cBias<0) the mean proportion.
// proximity ∈ [0,1]: 1 = exactly at meanProp, 0 = as far as possible. cBias ∈ [-1,1].
function circWeight(proximity: number, cBias: number): number {
  return Math.max(0, 1 + cBias * (2 * proximity - 1))
}

// Gaussian proximity weight centered on the ray's crossing index, scaled by bias.
// bias=0 → weight=1 for all samples (no influence); bias=1 → full sharpness.
// dist is the signed distance in ray-sample units from the crossing.
const CROSS_SHARPNESS = 8
function crossingWeight(dist: number, sigma: number, bias: number): number {
  return Math.exp(-0.5 * (dist / sigma) ** 2 * bias * CROSS_SHARPNESS)
}

export function detectByGradient(
  imageSrc:   ImageBitmap | OffscreenCanvas,
  maskSrc:    OffscreenCanvas | null,
  numRays:    number,
  windowSize: number,
  workSize:   number,
  radialBias: number,  // [0,1] — stroke bound: proximity strength; no stroke: centroid/boundary bias
  circBias:   number,  // [0,1] — ignored when strokeSrc is bound
  gradMode:   number,  // [0,1]: 0=luma only, 0.5=blend, 1=chroma only
  strokeSrc:  OffscreenCanvas | null, // filled-interior canvas of bound path/stroke
): Point[] | null {
  const W = workSize, H = workSize
  const scaleX = imageSrc.width  / W
  const scaleY = imageSrc.height / H

  // Down-sample image into work buffer
  const iOsc = new OffscreenCanvas(W, H)
  const iCtx = iOsc.getContext('2d')!
  iCtx.drawImage(imageSrc, 0, 0, W, H)
  const iPx = iCtx.getImageData(0, 0, W, H).data

  const sal = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    sal[i] = salience(iPx[i * 4]! / 255, iPx[i * 4 + 1]! / 255, iPx[i * 4 + 2]! / 255, gradMode)
  }

  // Down-sample mask (optional) — clips ray walk and weights centroid
  let maskA: Uint8ClampedArray | null = null
  if (maskSrc !== null) {
    const mOsc = new OffscreenCanvas(W, H)
    const mCtx = mOsc.getContext('2d')!
    mCtx.drawImage(maskSrc, 0, 0, W, H)
    maskA = mCtx.getImageData(0, 0, W, H).data
  }

  // Down-sample stroke fill (optional) — provides centroid and per-ray crossings
  let strokeAlpha: Uint8ClampedArray | null = null
  if (strokeSrc !== null) {
    const sOsc = new OffscreenCanvas(W, H)
    const sCtx = sOsc.getContext('2d')!
    sCtx.drawImage(strokeSrc, 0, 0, W, H)
    strokeAlpha = sCtx.getImageData(0, 0, W, H).data
  }

  // Centroid — from stroke fill when bound, else mask alpha or salience
  let cx = 0, cy = 0, wt = 0
  if (strokeAlpha !== null) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = strokeAlpha[(y * W + x) * 4 + 3]! / 255
        if (a < 0.5) continue
        cx += x; cy += y; wt++
      }
    }
  } else {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const w = maskA ? maskA[i * 4 + 3]! / 255 : sal[i]!
        cx += x * w; cy += y * w; wt += w
      }
    }
  }
  if (wt < 1) return null
  cx /= wt; cy /= wt

  const half  = Math.max(0, Math.floor(windowSize / 2))
  const rBias = 2 * radialBias - 1   // ∈ [-1, 1]
  const cBias = 2 * circBias   - 1   // ∈ [-1, 1]
  // Gaussian sigma for crossing proximity, in ray-sample units
  const crossSigma = Math.max(4, windowSize * 2)

  type RayCache = {
    pos:         { x: number; y: number }[]
    sm:          Float32Array
    maxProp:     number
    crossingIdx: number   // -1 if ray has no stroke crossing
  }
  const cache: RayCache[] = []

  // Pass 1 — find max-weighted gradient; record fractional position and crossing
  for (let ray = 0; ray < numRays; ray++) {
    const angle = (ray / numRays) * Math.PI * 2
    const dx = Math.cos(angle), dy = Math.sin(angle)

    const raw: number[] = []
    const pos: { x: number; y: number }[] = []

    for (let t = 1; t < W + H; t++) {
      const px = Math.round(cx + t * dx)
      const py = Math.round(cy + t * dy)
      if (px < 0 || py < 0 || px >= W || py >= H) break
      if (maskA && maskA[(py * W + px) * 4 + 3]! < 10) break
      raw.push(sal[py * W + px]!)
      pos.push({ x: px, y: py })
    }

    const n = raw.length
    if (n < 2) {
      cache.push({ pos, sm: new Float32Array(0), maxProp: 0, crossingIdx: -1 })
      continue
    }

    // Box-filter smoothing
    const sm = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0
      for (let d = -half; d <= half; d++) {
        const j = i + d
        if (j >= 0 && j < n) { sum += raw[j]!; cnt++ }
      }
      sm[i] = cnt > 0 ? sum / cnt : 0
    }

    // Find where this ray crosses the stroke boundary.
    // The stroke canvas is a filled white interior, so rays start inside (alpha≈1)
    // and exit at the boundary. crossingIdx = last sample with alpha > 0.5.
    let crossingIdx = -1
    if (strokeAlpha !== null) {
      for (let i = 0; i < n; i++) {
        const { x: spx, y: spy } = pos[i]!
        if (strokeAlpha[(spy * W + spx) * 4 + 3]! > 127) crossingIdx = i
      }
    }

    // Score each gradient with proximity weight; skip the inner 20% of the ray
    const span   = Math.max(1, n - 1)
    const startI = Math.max(1, Math.ceil(n * 0.2))
    let maxG = -1, maxIdx = n - 1
    for (let i = startI; i < n; i++) {
      const w = crossingIdx >= 0
        ? crossingWeight(i - crossingIdx, crossSigma, radialBias)
        : radialWeight(i / span, rBias)
      const g = Math.abs(sm[i]! - sm[i - 1]!) * w
      if (g > maxG) { maxG = g; maxIdx = i }
    }

    cache.push({ pos, sm, maxProp: maxIdx / span, crossingIdx })
  }

  // Mean proportional position across all valid rays
  const valid = cache.filter(r => r.sm.length >= 2)
  if (valid.length === 0) return null
  const meanProp = valid.reduce((s, r) => s + r.maxProp, 0) / valid.length
  const maxDist  = Math.max(meanProp, 1 - meanProp, 0.01)

  // Pass 2 — re-score; when stroke bound use crossing proximity only,
  // otherwise combine radial × circularity weights
  const pts: Point[] = []
  for (const { pos, sm, crossingIdx } of cache) {
    const n = sm.length
    if (n < 2) continue

    const span   = Math.max(1, n - 1)
    const startI = Math.max(1, Math.ceil(n * 0.2))
    let maxG = -1, maxIdx = n - 1
    for (let i = startI; i < n; i++) {
      let g: number
      if (crossingIdx >= 0) {
        g = Math.abs(sm[i]! - sm[i - 1]!) * crossingWeight(i - crossingIdx, crossSigma, radialBias)
      } else {
        const p         = i / span
        const rw        = radialWeight(p, rBias)
        const proximity = 1 - Math.abs(p - meanProp) / maxDist
        const cw        = circWeight(proximity, cBias)
        g = Math.abs(sm[i]! - sm[i - 1]!) * rw * cw
      }
      if (g > maxG) { maxG = g; maxIdx = i }
    }

    const q = pos[maxIdx]!
    pts.push({ x: q.x * scaleX, y: q.y * scaleY })
  }

  return pts.length >= 3 ? pts : null
}
