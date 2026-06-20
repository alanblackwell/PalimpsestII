// Shared mask/image boundary-tracing pipeline.
// Used by EdgePathLayer (every detection) and ClipPathLayer (one-shot init).
//
// detectContour(imageSrc, maskSrc, numPts)
//   mask present  → downsample alpha → Moore boundary trace
//   mask absent   → greyscale → blur → Otsu → largest component → trace
//   returns Point[] in image coordinates, or null if nothing was found.

import type { Point } from '../core/types.js'

const PROC_SIZE   = 400
const FINDER_SIZE = 128

type Px = { x: number; y: number }

// ── Mask bounding box ─────────────────────────────────────────────

function maskBbox(
  mask: OffscreenCanvas,
): { x: number; y: number; w: number; h: number } | null {
  const F    = FINDER_SIZE
  const fOsc = new OffscreenCanvas(F, F)
  const fCtx = fOsc.getContext('2d')!
  fCtx.drawImage(mask, 0, 0, F, F)
  const d = fCtx.getImageData(0, 0, F, F).data
  let x1 = F, y1 = F, x2 = -1, y2 = -1
  for (let y = 0; y < F; y++) for (let x = 0; x < F; x++)
    if (d[(y * F + x) * 4 + 3] > 10) {
      if (x < x1) x1 = x; if (y < y1) y1 = y
      if (x > x2) x2 = x; if (y > y2) y2 = y
    }
  if (x2 < x1) return null
  return {
    x: Math.floor(x1 / F * mask.width),   y: Math.floor(y1 / F * mask.height),
    w: Math.ceil((x2 - x1 + 1) / F * mask.width),
    h: Math.ceil((y2 - y1 + 1) / F * mask.height),
  }
}

// ── Moore's boundary tracing ──────────────────────────────────────

function traceBoundary(binary: Uint8Array, W: number, H: number): Px[] {
  let sx = -1, sy = -1
  outer: for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (binary[y * W + x]) { sx = x; sy = y; break outer }
    }
  }
  if (sx < 0) return []

  // 8-connected clockwise (E, SE, S, SW, W, NW, N, NE)
  const DX = [ 1,  1,  0, -1, -1, -1,  0,  1]
  const DY = [ 0,  1,  1,  1,  0, -1, -1, -1]

  const path: Px[] = []
  let bx = sx, by = sy, iterDir = 4  // start entry: W
  for (let iter = 0; iter < W * H * 2; iter++) {
    path.push({ x: bx, y: by })
    let foundDir = -1, lastBgDir = iterDir
    for (let k = 0; k < 8; k++) {
      const d  = (iterDir + k) % 8
      const nx = bx + DX[d], ny = by + DY[d]
      const fg = nx >= 0 && ny >= 0 && nx < W && ny < H && binary[ny * W + nx] !== 0
      if (fg) { foundDir = d; break }
      lastBgDir = d
    }
    if (foundDir < 0) break
    const nx = bx + DX[foundDir], ny = by + DY[foundDir]
    if (nx === sx && ny === sy && path.length > 1) break
    const ex = DX[lastBgDir] - DX[foundDir], ey = DY[lastBgDir] - DY[foundDir]
    let newDir = 0
    for (let i = 0; i < 8; i++) {
      if (DX[i] === ex && DY[i] === ey) { newDir = i; break }
    }
    bx = nx; by = ny; iterDir = newDir
  }
  return path
}

// ── Otsu threshold ────────────────────────────────────────────────

function otsuThreshold(gray: Float32Array, N: number): number {
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
    const v  = wB * wF * (mB - mF) * (mB - mF)
    if (v > maxVar) { maxVar = v; thresh = t }
  }
  return thresh / 255
}

// ── Largest 4-connected component ────────────────────────────────

function largestComponent(binary: Uint8Array, W: number, H: number): Uint8Array {
  const N = W * H
  const label = new Int32Array(N)
  let nextLabel = 1, bestLabel = 0, bestSize = 0
  const sizes: number[] = [0]
  for (let i = 0; i < N; i++) {
    if (!binary[i] || label[i]) continue
    const lbl = nextLabel++; sizes.push(0)
    const q = [i]; label[i] = lbl; let qi = 0
    while (qi < q.length) {
      const idx = q[qi++]; sizes[lbl] = (sizes[lbl] ?? 0) + 1
      const x = idx % W, y = (idx / W) | 0
      for (const n of [y > 0 ? idx - W : -1, y < H - 1 ? idx + W : -1,
                        x > 0 ? idx - 1 : -1, x < W - 1 ? idx + 1 : -1]) {
        if (n >= 0 && binary[n] && !label[n]) { label[n] = lbl; q.push(n) }
      }
    }
    if ((sizes[lbl] ?? 0) > bestSize) { bestSize = sizes[lbl] ?? 0; bestLabel = lbl }
  }
  const out = new Uint8Array(N)
  if (bestLabel > 0) for (let i = 0; i < N; i++) out[i] = label[i] === bestLabel ? 1 : 0
  return out
}

// ── Gaussian blur (5-tap separable) ──────────────────────────────

function gaussBlur(src: Float32Array, W: number, H: number): Float32Array {
  const k   = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0
    for (let d = -2; d <= 2; d++) s += src[y * W + Math.max(0, Math.min(W - 1, x + d))] * k[d + 2]!
    tmp[y * W + x] = s
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0
    for (let d = -2; d <= 2; d++) s += tmp[Math.max(0, Math.min(H - 1, y + d)) * W + x] * k[d + 2]!
    out[y * W + x] = s
  }
  return out
}

// ── Uniform arc-length resampler ──────────────────────────────────

function uniformResample(pts: Px[], n: number): Px[] {
  if (pts.length < 2) return pts.length === 0 ? [] : Array(n).fill(pts[0])
  const len = [0]
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x, dy = pts[i]!.y - pts[i - 1]!.y
    len.push(len[i - 1]! + Math.sqrt(dx * dx + dy * dy))
  }
  const total = len[len.length - 1]!
  if (total === 0) return pts.slice(0, n)
  const out: Px[] = []
  let j = 0
  for (let i = 0; i < n; i++) {
    const tgt = (i / n) * total
    while (j < len.length - 2 && len[j + 1]! < tgt) j++
    const sp = len[j + 1]! - len[j]!, t = sp > 0 ? (tgt - len[j]!) / sp : 0
    out.push({ x: pts[j]!.x + t * (pts[j + 1]!.x - pts[j]!.x), y: pts[j]!.y + t * (pts[j + 1]!.y - pts[j]!.y) })
  }
  return out
}

// ── 1-pass binomial smooth ────────────────────────────────────────

function smoothPoints(pts: Point[]): Point[] {
  const n = pts.length, out: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n]!, b = pts[i]!, c = pts[(i + 1) % n]!
    out.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 })
  }
  return out
}

// ── Public entry point ────────────────────────────────────────────

export function detectContour(
  imageSrc: ImageBitmap | OffscreenCanvas,
  maskSrc:  OffscreenCanvas | null,
  numPts:   number,
): Point[] | null {
  // 1. Crop region from mask bbox (if available)
  let cropX = 0, cropY = 0, cropW = imageSrc.width, cropH = imageSrc.height
  if (maskSrc !== null) {
    const bb = maskBbox(maskSrc)
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

  // 2. Build binary foreground map
  let binary: Uint8Array

  if (maskSrc !== null) {
    const mOsc = new OffscreenCanvas(pw, ph)
    const mCtx = mOsc.getContext('2d')!
    mCtx.drawImage(maskSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
    const mPx = mCtx.getImageData(0, 0, pw, ph).data
    binary = new Uint8Array(pw * ph)
    for (let i = 0; i < pw * ph; i++) binary[i] = mPx[i * 4 + 3] > 0 ? 1 : 0
  } else {
    const iOsc = new OffscreenCanvas(pw, ph)
    const iCtx = iOsc.getContext('2d')!
    iCtx.drawImage(imageSrc, cropX, cropY, cropW, cropH, 0, 0, pw, ph)
    const iPx  = iCtx.getImageData(0, 0, pw, ph).data
    const gray = new Float32Array(pw * ph)
    for (let i = 0; i < pw * ph; i++)
      gray[i] = (0.299 * iPx[i * 4]! + 0.587 * iPx[i * 4 + 1]! + 0.114 * iPx[i * 4 + 2]!) / 255
    const blurred = gaussBlur(gray, pw, ph)
    const thresh  = otsuThreshold(blurred, pw * ph)
    const raw     = new Uint8Array(pw * ph)
    for (let i = 0; i < pw * ph; i++) raw[i] = blurred[i]! > thresh ? 1 : 0
    binary = largestComponent(raw, pw, ph)
  }

  // 3. Trace boundary → resample → canvas coords
  const chain = traceBoundary(binary, pw, ph)
  if (chain.length < 3) return null

  const resampled = uniformResample(chain, numPts)
  const sx = cropW / pw, sy = cropH / ph
  return smoothPoints(
    resampled.map(p => ({ x: cropX + p.x * sx, y: cropY + p.y * sy })),
  )
}
