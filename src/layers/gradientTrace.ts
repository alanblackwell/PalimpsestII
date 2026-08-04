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
//   Without prior bound: radialWeight — biases toward centroid or boundary.
//   With prior bound: Gaussian proximity to where the ray crosses the filled
//     prior region. The same weight applies whether the sample is inside
//     or outside the boundary. circWeight is not applied when prior is bound
//     (the crossing gives a per-ray boundary estimate directly).
//
// When priorSrc is provided it must be a filled white canvas of the shape/path
// interior (see TraceLayer._buildPriorCanvas). The centroid is derived from
// those filled pixels; each ray finds its crossing as the last sample inside
// the filled region.
//
// radialBias ∈ [0,1]:
//   Prior bound  — 0 = no proximity weighting (pure gradient magnitude);
//                  1 = crossing sample always wins (full Gaussian sharpness).
//   No prior     — 0 = weight toward centroid, 0.5 = neutral, 1 = toward boundary.
// circBias   ∈ [0,1]: 0 = weight away from mean (spread), 0.5 = neutral, 1 = toward mean.
//   Only used when no prior source is bound.
// marginBias ∈ [0,1]: extra fraction of each ray's far end excluded from candidate
//   scoring, on top of the fixed exclusion already needed for the box-filter's
//   truncated window there (see rayScoreRange). Raise this when a ray runs all the
//   way to the image frame edge (no mask to stop it early) and the frame edge itself
//   is being picked up as a false "edge".
//
// includeColour/excludeColour/colourWeight: optional colour priors (sampled from the
// image by TraceLayer's tick/cross handles), scored directionally per ray — see
// computeColourScore. Walking outward from the centroid, evidence of includeColour
// is tracked as a running gate that only rises, never resets, so the colour score
// stays near zero until the ray has actually passed through includeColour. From
// there it rewards leaving the include-coloured region for *anything* else (so
// includeColour alone, with no excludeColour bound, still has an effect), with an
// extra boost — EXCLUDE_BOOST — where what it lands on specifically matches
// excludeColour. The reverse transition (exclude→include, moving outward) scores
// ~0 — no gate ever accumulates on the exclude side. colourWeight = 0 is exactly a
// no-op (today's |Δsm| scoring, unchanged).
//
// gradMode also controls how colourCloseness compares colours, mirroring its
// meaning for salience(): 0 = compare brightness only (desaturated — a colour and
// its greyscale equivalent are indistinguishable), 0.5 = blend, 1 = compare
// hue/saturation only (brightness ignored).

import type { Colour, Point } from '../core/types.js'

// gradMode 0 = luma only, 0.5 = current blend (luma + 0.35*chroma), 1 = chroma only
function salience(r: number, g: number, b: number, gradMode: number): number {
  const luma   = 0.299 * r + 0.587 * g + 0.114 * b
  const chroma = Math.max(r, g, b) - Math.min(r, g, b)
  const wL = gradMode <= 0.5 ? 1 : 2 * (1 - gradMode)
  const wC = gradMode <= 0.5 ? 0.7 * gradMode : 0.35 + 1.3 * (gradMode - 0.5)
  return wL * luma + wC * chroma
}

const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114

// 0..1 closeness of an RGB pixel to a sampled Colour (1 = identical, 0 = maximally
// far), blending luma-distance and chroma-distance the same way salience() blends
// luma and chroma magnitude — gradMode 0 = brightness only, 1 = hue/saturation only.
const RGB_MAX_DIST = Math.sqrt(3)
function colourCloseness(r: number, g: number, b: number, c: Colour, gradMode: number): number {
  const dr = r - c.r, dg = g - c.g, db = b - c.b
  // Signed projection of the RGB difference onto the luma axis, and the
  // orthogonal (chroma) residual — an exact decomposition of the RGB distance.
  const dLuma  = LUMA_R * dr + LUMA_G * dg + LUMA_B * db
  const crR = dr - dLuma * LUMA_R, crG = dg - dLuma * LUMA_G, crB = db - dLuma * LUMA_B
  const lumaDist   = Math.abs(dLuma)
  const chromaDist = Math.sqrt(crR * crR + crG * crG + crB * crB)

  const wL = gradMode <= 0.5 ? 1 : 2 * (1 - gradMode)
  const wC = gradMode <= 0.5 ? 0.7 * gradMode : 0.35 + 1.3 * (gradMode - 0.5)
  const dist = (wL * lumaDist + wC * chromaDist) / (wL + wC)
  return 1 - Math.min(1, dist / RGB_MAX_DIST)
}

// How much more a transition that specifically lands on excludeColour counts,
// relative to a same-strength transition away from includeColour into anything else.
const EXCLUDE_BOOST = 1.5

// Directional colour transition score along one ray, indexed the same as that ray's
// `pos`/`sm` arrays — see the module comment above. Requires includeColour (nothing
// to gate on otherwise); excludeColour is optional.
function computeColourScore(
  pos: { x: number; y: number }[], iPx: Uint8ClampedArray, W: number,
  includeColour: Colour | null, excludeColour: Colour | null, gradMode: number,
): Float32Array {
  const n = pos.length
  const score = new Float32Array(n)
  if (includeColour === null) return score

  let inclGate = 0
  for (let i = 0; i < n; i++) {
    const { x: px, y: py } = pos[i]!
    const idx = (py * W + px) * 4
    const r = iPx[idx]! / 255, g = iPx[idx + 1]! / 255, b = iPx[idx + 2]! / 255
    const closeIncl = colourCloseness(r, g, b, includeColour, gradMode)
    score[i] = excludeColour !== null
      ? inclGate * ((1 - closeIncl) + EXCLUDE_BOOST * colourCloseness(r, g, b, excludeColour, gradMode)) / (1 + EXCLUDE_BOOST)
      : inclGate * (1 - closeIncl)
    if (closeIncl > inclGate) inclGate = closeIncl
  }
  return score
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

// Candidate index range [startI, endI] for gradient scoring along a ray of n samples.
// startI skips the inner 20% near the centroid (never a useful "boundary" there).
// endI skips the outer `half` samples unconditionally — the box filter's averaging
// window is truncated within `half` samples of either end, so residual noise (not
// smoothed away) inflates |sm[i]-sm[i-1]| right there regardless of image content.
// marginFrac adds a further, caller-tunable exclusion at the far end for rays that
// run uninterrupted to the image frame edge (see marginBias above).
const MAX_MARGIN_FRAC = 0.4
function rayScoreRange(n: number, half: number, marginFrac: number): { startI: number; endI: number } {
  const startI  = Math.max(1, Math.ceil(n * 0.2))
  const farCut  = Math.max(half, Math.ceil(n * marginFrac * MAX_MARGIN_FRAC))
  const endI    = Math.max(startI, n - 1 - farCut)
  return { startI, endI }
}

export function detectByGradient(
  imageSrc:   ImageBitmap | OffscreenCanvas,
  maskSrc:    OffscreenCanvas | null,
  numRays:    number,
  windowSize: number,
  workSize:   number,
  radialBias: number,  // [0,1] — stroke bound: proximity strength; no stroke: centroid/boundary bias
  circBias:   number,  // [0,1] — ignored when priorSrc is bound
  gradMode:   number,  // [0,1]: 0=luma only, 0.5=blend, 1=chroma only
  marginBias: number,  // [0,1] — extra exclusion of each ray's far end (image-boundary false edges)
  includeColour: Colour | null,  // colour prior expected inside the boundary, or null if unset
  excludeColour: Colour | null,  // colour prior expected outside the boundary, or null if unset
  colourWeight:  number,         // [0,1] — 0 = no colour influence (exact no-op)
  priorSrc:   OffscreenCanvas | null, // filled-interior canvas of bound shape/path/stroke
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

  // Down-sample prior fill (optional) — provides centroid and per-ray crossings
  let priorAlpha: Uint8ClampedArray | null = null
  if (priorSrc !== null) {
    const sOsc = new OffscreenCanvas(W, H)
    const sCtx = sOsc.getContext('2d')!
    sCtx.drawImage(priorSrc, 0, 0, W, H)
    priorAlpha = sCtx.getImageData(0, 0, W, H).data
  }

  // Centroid — from prior fill when bound, else mask alpha or salience
  let cx = 0, cy = 0, wt = 0
  if (priorAlpha !== null) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = priorAlpha[(y * W + x) * 4 + 3]! / 255
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
    colourScore: Float32Array   // directional include→exclude score, see computeColourScore
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
      // Stop at the image's own content edge, not the canvas edge — imageSrc is
      // typically a canvas-sized composite with the actual bitmap positioned/scaled
      // inside it and everything else transparent (see ImageLayer._updateOffscreen).
      // Walking past this into the padding turns the transparent→opaque transition
      // into a spurious high-gradient "edge" partway along the ray.
      if (iPx[(py * W + px) * 4 + 3]! < 10) break
      raw.push(sal[py * W + px]!)
      pos.push({ x: px, y: py })
    }

    const n = raw.length
    if (n < 2) {
      cache.push({ pos, sm: new Float32Array(0), maxProp: 0, crossingIdx: -1, colourScore: new Float32Array(0) })
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

    const colourScore = colourWeight > 0
      ? computeColourScore(pos, iPx, W, includeColour, excludeColour, gradMode)
      : new Float32Array(n)

    // Find where this ray crosses the prior boundary.
    // The prior canvas is a filled white interior, so rays start inside (alpha≈1)
    // and exit at the boundary. crossingIdx = last sample with alpha > 0.5.
    let crossingIdx = -1
    if (priorAlpha !== null) {
      for (let i = 0; i < n; i++) {
        const { x: spx, y: spy } = pos[i]!
        if (priorAlpha[(spy * W + spx) * 4 + 3]! > 127) crossingIdx = i
      }
    }

    // Score each gradient with proximity weight; skip the inner 20% of the ray
    // and the (fixed + tunable) exclusion zone at the far end — see rayScoreRange.
    const span = Math.max(1, n - 1)
    const { startI, endI } = rayScoreRange(n, half, marginBias)
    let maxG = -1, maxIdx = endI
    for (let i = startI; i <= endI; i++) {
      const posWeight = crossingIdx >= 0
        ? crossingWeight(i - crossingIdx, crossSigma, radialBias)
        : radialWeight(i / span, rBias)
      const gradTerm = Math.abs(sm[i]! - sm[i - 1]!)
      const g = (colourWeight > 0
        ? (1 - colourWeight) * gradTerm + colourWeight * colourScore[i]!
        : gradTerm) * posWeight
      if (g > maxG) { maxG = g; maxIdx = i }
    }

    cache.push({ pos, sm, maxProp: maxIdx / span, crossingIdx, colourScore })
  }

  // Mean proportional position across all valid rays
  const valid = cache.filter(r => r.sm.length >= 2)
  if (valid.length === 0) return null
  const meanProp = valid.reduce((s, r) => s + r.maxProp, 0) / valid.length
  const maxDist  = Math.max(meanProp, 1 - meanProp, 0.01)

  // Pass 2 — re-score; when stroke bound use crossing proximity only,
  // otherwise combine radial × circularity weights
  const pts: Point[] = []
  for (const { pos, sm, crossingIdx, colourScore } of cache) {
    const n = sm.length
    if (n < 2) continue

    const span = Math.max(1, n - 1)
    const { startI, endI } = rayScoreRange(n, half, marginBias)
    let maxG = -1, maxIdx = endI
    for (let i = startI; i <= endI; i++) {
      let posWeight: number
      if (crossingIdx >= 0) {
        posWeight = crossingWeight(i - crossingIdx, crossSigma, radialBias)
      } else {
        const p         = i / span
        const rw        = radialWeight(p, rBias)
        const proximity = 1 - Math.abs(p - meanProp) / maxDist
        const cw        = circWeight(proximity, cBias)
        posWeight = rw * cw
      }
      const gradTerm = Math.abs(sm[i]! - sm[i - 1]!)
      const g = (colourWeight > 0
        ? (1 - colourWeight) * gradTerm + colourWeight * colourScore[i]!
        : gradTerm) * posWeight
      if (g > maxG) { maxG = g; maxIdx = i }
    }

    const q = pos[maxIdx]!
    pts.push({ x: q.x * scaleX, y: q.y * scaleY })
  }

  return pts.length >= 3 ? pts : null
}
